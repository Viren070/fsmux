import net from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  AUTH_NONE,
  AUTH_SYS,
  MSG_CALL,
  RPC_VERSION,
  REPLY_ACCEPTED,
  RecordReader,
  frameRecord,
} from '../rpc.js';
import { XdrReader, XdrWriter } from '../xdr.js';
import { readBitmap, writeBitmap } from './attrs.js';
import {
  FATTR4,
  NFS_PROGRAM,
  NFS_V4,
  NFSPROC4_COMPOUND,
  NFSPROC4_NULL,
  OP,
  OPEN4_NOCREATE,
  OPEN4_SHARE_ACCESS_READ,
  CLAIM_NULL,
  OPEN4_CREATE,
  UNCHECKED4,
} from './constants.js';
import { readStateid, writeStateid, type Stateid } from './state.js';

/** A small NFSv4.0 client, enough to drive a server op by op in tests. */
export interface RpcReply {
  xid: number;
  replyStat: number;
  /** Accepted replies. */
  acceptStat?: number;
  mismatch?: { low: number; high: number };
  /** Denied replies. */
  rejectStat?: number;
  authStat?: number;
  /** Positioned at the results (accepted, success) or after the header. */
  reader: XdrReader;
}

export interface OpSpec {
  op: number;
  args?: (w: XdrWriter) => void;
  decode?: (r: XdrReader) => unknown;
}

export interface OpResult {
  op: number;
  status: number;
  value?: unknown;
}

export interface CompoundReply {
  status: number;
  tag: string;
  results: OpResult[];
}

export interface Fattr {
  attrs: number[];
  values: Map<number, unknown>;
}

export interface DirEntry {
  cookie: bigint;
  name: string;
  attrs: Fattr;
}

function readTime(r: XdrReader): { seconds: bigint; nseconds: number } {
  return { seconds: r.int64(), nseconds: r.uint32() };
}

const ATTR_DECODERS: Record<number, (r: XdrReader) => unknown> = {
  [FATTR4.SUPPORTED_ATTRS]: readBitmap,
  [FATTR4.TYPE]: (r) => r.uint32(),
  [FATTR4.FH_EXPIRE_TYPE]: (r) => r.uint32(),
  [FATTR4.CHANGE]: (r) => r.uint64(),
  [FATTR4.SIZE]: (r) => r.uint64(),
  [FATTR4.LINK_SUPPORT]: (r) => r.bool(),
  [FATTR4.SYMLINK_SUPPORT]: (r) => r.bool(),
  [FATTR4.NAMED_ATTR]: (r) => r.bool(),
  [FATTR4.FSID]: (r) => ({ major: r.uint64(), minor: r.uint64() }),
  [FATTR4.UNIQUE_HANDLES]: (r) => r.bool(),
  [FATTR4.LEASE_TIME]: (r) => r.uint32(),
  [FATTR4.RDATTR_ERROR]: (r) => r.uint32(),
  [FATTR4.ACLSUPPORT]: (r) => r.uint32(),
  [FATTR4.CASE_INSENSITIVE]: (r) => r.bool(),
  [FATTR4.CASE_PRESERVING]: (r) => r.bool(),
  [FATTR4.FILEHANDLE]: (r) => Buffer.from(r.opaqueVar()),
  [FATTR4.FILEID]: (r) => r.uint64(),
  [FATTR4.FILES_TOTAL]: (r) => r.uint64(),
  [FATTR4.MAXFILESIZE]: (r) => r.uint64(),
  [FATTR4.MAXNAME]: (r) => r.uint32(),
  [FATTR4.MAXREAD]: (r) => r.uint64(),
  [FATTR4.MAXWRITE]: (r) => r.uint64(),
  [FATTR4.MODE]: (r) => r.uint32(),
  [FATTR4.NUMLINKS]: (r) => r.uint32(),
  [FATTR4.OWNER]: (r) => r.string(),
  [FATTR4.OWNER_GROUP]: (r) => r.string(),
  [FATTR4.RAWDEV]: (r) => ({ major: r.uint32(), minor: r.uint32() }),
  [FATTR4.SPACE_TOTAL]: (r) => r.uint64(),
  [FATTR4.SPACE_USED]: (r) => r.uint64(),
  [FATTR4.TIME_ACCESS]: readTime,
  [FATTR4.TIME_DELTA]: readTime,
  [FATTR4.TIME_METADATA]: readTime,
  [FATTR4.TIME_MODIFY]: readTime,
  [FATTR4.MOUNTED_ON_FILEID]: (r) => r.uint64(),
};

export function decodeFattr(r: XdrReader): Fattr {
  const attrs = readBitmap(r);
  const raw = r.opaqueVar();
  const vr = new XdrReader(raw);
  const values = new Map<number, unknown>();
  for (const attr of attrs) {
    const decode = ATTR_DECODERS[attr];
    if (!decode) throw new Error(`no test decoder for attribute ${attr}`);
    values.set(attr, decode(vr));
  }
  if (!vr.done()) throw new Error('attribute values longer than decoded');
  return { attrs, values };
}

function readChangeInfo(r: XdrReader) {
  return { atomic: r.bool(), before: r.uint64(), after: r.uint64() };
}

/** Builders for the ops a test sends. */
export const ops = {
  putrootfh: (): OpSpec => ({ op: OP.PUTROOTFH }),
  putpubfh: (): OpSpec => ({ op: OP.PUTPUBFH }),
  putfh: (fh: Buffer): OpSpec => ({
    op: OP.PUTFH,
    args: (w) => w.opaqueVar(fh),
  }),
  getfh: (): OpSpec => ({
    op: OP.GETFH,
    decode: (r) => Buffer.from(r.opaqueVar()),
  }),
  savefh: (): OpSpec => ({ op: OP.SAVEFH }),
  restorefh: (): OpSpec => ({ op: OP.RESTOREFH }),
  lookup: (name: string): OpSpec => ({
    op: OP.LOOKUP,
    args: (w) => w.string(name),
  }),
  lookupp: (): OpSpec => ({ op: OP.LOOKUPP }),
  getattr: (attrs: number[]): OpSpec => ({
    op: OP.GETATTR,
    args: (w) => writeBitmap(w, attrs),
    decode: decodeFattr,
  }),
  access: (mask: number): OpSpec => ({
    op: OP.ACCESS,
    args: (w) => w.uint32(mask),
    decode: (r) => ({ supported: r.uint32(), access: r.uint32() }),
  }),
  readlink: (): OpSpec => ({ op: OP.READLINK, decode: (r) => r.string() }),
  readdir: (opts: {
    cookie?: bigint;
    dircount?: number;
    maxcount?: number;
    attrs?: number[];
  }): OpSpec => ({
    op: OP.READDIR,
    args: (w) => {
      w.uint64(opts.cookie ?? 0n)
        .opaqueFixed(Buffer.alloc(8))
        .uint32(opts.dircount ?? 8192)
        .uint32(opts.maxcount ?? 32768);
      writeBitmap(w, opts.attrs ?? []);
    },
    decode: (r) => {
      r.opaqueFixed(8);
      const entries: DirEntry[] = [];
      while (r.bool()) {
        entries.push({
          cookie: r.uint64(),
          name: r.string(),
          attrs: decodeFattr(r),
        });
      }
      return { entries, eof: r.bool() };
    },
  }),
  read: (stateid: Stateid, offset: number | bigint, count: number): OpSpec => ({
    op: OP.READ,
    args: (w) => {
      writeStateid(w, stateid);
      w.uint64(BigInt(offset)).uint32(count);
    },
    decode: (r) => ({ eof: r.bool(), data: Buffer.from(r.opaqueVar()) }),
  }),
  open: (
    clientId: bigint,
    name: string,
    opts: {
      access?: number;
      create?: boolean;
      claim?: number;
      owner?: Buffer;
    } = {},
  ): OpSpec => ({
    op: OP.OPEN,
    args: (w) => {
      w.uint32(0)
        .uint32(opts.access ?? OPEN4_SHARE_ACCESS_READ)
        .uint32(0)
        .uint64(clientId)
        .opaqueVar(opts.owner ?? Buffer.from('owner'));
      if (opts.create) {
        w.uint32(OPEN4_CREATE).uint32(UNCHECKED4);
        writeBitmap(w, []);
        w.opaqueVar(Buffer.alloc(0));
      } else {
        w.uint32(OPEN4_NOCREATE);
      }
      w.uint32(opts.claim ?? CLAIM_NULL);
      if ((opts.claim ?? CLAIM_NULL) === CLAIM_NULL) w.string(name);
      else w.uint32(0);
    },
    decode: (r) => ({
      stateid: readStateid(r),
      change: readChangeInfo(r),
      rflags: r.uint32(),
      attrset: readBitmap(r),
      delegation: r.uint32(),
    }),
  }),
  openConfirm: (stateid: Stateid): OpSpec => ({
    op: OP.OPEN_CONFIRM,
    args: (w) => {
      writeStateid(w, stateid);
      w.uint32(1);
    },
    decode: readStateid,
  }),
  close: (stateid: Stateid): OpSpec => ({
    op: OP.CLOSE,
    args: (w) => {
      w.uint32(1);
      writeStateid(w, stateid);
    },
    decode: readStateid,
  }),
  setclientid: (id: Buffer, verifier: Buffer): OpSpec => ({
    op: OP.SETCLIENTID,
    args: (w) => {
      w.opaqueFixed(verifier)
        .opaqueVar(id)
        .uint32(0)
        .string('tcp')
        .string('0.0.0.0.0.0')
        .uint32(1);
    },
    decode: (r) => ({
      clientId: r.uint64(),
      confirm: Buffer.from(r.opaqueFixed(8)),
    }),
  }),
  setclientidConfirm: (clientId: bigint, confirm: Buffer): OpSpec => ({
    op: OP.SETCLIENTID_CONFIRM,
    args: (w) => w.uint64(clientId).opaqueFixed(confirm),
  }),
  renew: (clientId: bigint): OpSpec => ({
    op: OP.RENEW,
    args: (w) => w.uint64(clientId),
  }),
  remove: (name: string): OpSpec => ({
    op: OP.REMOVE,
    args: (w) => w.string(name),
    decode: readChangeInfo,
  }),
  secinfo: (name: string): OpSpec => ({
    op: OP.SECINFO,
    args: (w) => w.string(name),
    decode: (r) => {
      const n = r.uint32();
      const flavors: number[] = [];
      for (let i = 0; i < n; i++) flavors.push(r.uint32());
      return flavors;
    },
  }),
  verify: (attrs: number[], values: Buffer): OpSpec => ({
    op: OP.VERIFY,
    args: (w) => {
      writeBitmap(w, attrs);
      w.opaqueVar(values);
    },
  }),
  nverify: (attrs: number[], values: Buffer): OpSpec => ({
    op: OP.NVERIFY,
    args: (w) => {
      writeBitmap(w, attrs);
      w.opaqueVar(values);
    },
  }),
  raw: (op: number, args?: (w: XdrWriter) => void): OpSpec => ({ op, args }),
};

export class NfsClient {
  private xid = 1;
  private readonly pending = new Map<
    number,
    { resolve: (reply: Buffer) => void; reject: (err: Error) => void }
  >();
  private readonly reader: RecordReader;
  private closedError: Error | undefined;

  private constructor(private readonly socket: net.Socket) {
    this.reader = new RecordReader(8 * 1024 * 1024, (record) => {
      const xid = record.readUInt32BE(0);
      const waiter = this.pending.get(xid);
      this.pending.delete(xid);
      waiter?.resolve(record);
    });
    socket.on('data', (data) => this.reader.push(data));
    socket.on('close', () => {
      this.closedError = new Error('connection closed');
      for (const waiter of this.pending.values())
        waiter.reject(this.closedError);
      this.pending.clear();
    });
    socket.on('error', () => undefined);
  }

  static connect(port: number, host = '127.0.0.1'): Promise<NfsClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host);
      socket.once('connect', () => resolve(new NfsClient(socket)));
      socket.once('error', reject);
    });
  }

  /** Resolves true when the server closes the connection unprompted. */
  closedByPeer(timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.socket.destroyed || this.closedError) return resolve(true);
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  rpc(
    proc: number,
    args: Buffer,
    opts: {
      prog?: number;
      vers?: number;
      rpcVersion?: number;
      authFlavor?: number;
      authSys?: { uid: number; gid: number; machine?: string };
    } = {},
  ): Promise<RpcReply> {
    const xid = this.xid++;
    const w = new XdrWriter();
    w.uint32(xid)
      .uint32(MSG_CALL)
      .uint32(opts.rpcVersion ?? RPC_VERSION)
      .uint32(opts.prog ?? NFS_PROGRAM)
      .uint32(opts.vers ?? NFS_V4)
      .uint32(proc);
    const flavor = opts.authFlavor ?? (opts.authSys ? AUTH_SYS : AUTH_NONE);
    w.uint32(flavor);
    if (flavor === AUTH_SYS) {
      const cred = new XdrWriter();
      cred
        .uint32(0)
        .string(opts.authSys?.machine ?? 'test')
        .uint32(opts.authSys?.uid ?? 0)
        .uint32(opts.authSys?.gid ?? 0)
        .uint32(0);
      w.opaqueVar(cred.bytes());
    } else {
      w.opaqueVar(Buffer.alloc(0));
    }
    w.uint32(AUTH_NONE).opaqueVar(Buffer.alloc(0));
    w.raw(args);
    return new Promise((resolve, reject) => {
      if (this.closedError) return reject(this.closedError);
      const decode = (record: Buffer) => {
        const r = new XdrReader(record);
        r.uint32();
        r.uint32();
        const replyStat = r.uint32();
        const reply: RpcReply = { xid, replyStat, reader: r };
        if (replyStat === REPLY_ACCEPTED) {
          r.uint32();
          r.opaqueVar();
          reply.acceptStat = r.uint32();
          if (reply.acceptStat === 2)
            reply.mismatch = { low: r.uint32(), high: r.uint32() };
        } else {
          reply.rejectStat = r.uint32();
          if (reply.rejectStat === 0)
            reply.mismatch = { low: r.uint32(), high: r.uint32() };
          else reply.authStat = r.uint32();
        }
        resolve(reply);
      };
      this.pending.set(xid, { resolve: decode, reject });
      this.socket.write(frameRecord(w.bytes()));
    });
  }

  async null(): Promise<RpcReply> {
    return this.rpc(NFSPROC4_NULL, Buffer.alloc(0));
  }

  async compound(
    specs: OpSpec[],
    opts: { minor?: number; tag?: string } = {},
  ): Promise<CompoundReply> {
    const w = new XdrWriter();
    w.string(opts.tag ?? '')
      .uint32(opts.minor ?? 0)
      .uint32(specs.length);
    for (const spec of specs) {
      w.uint32(spec.op);
      spec.args?.(w);
    }
    const reply = await this.rpc(NFSPROC4_COMPOUND, w.bytes());
    if (reply.acceptStat !== 0) {
      throw new Error(`rpc accept status ${reply.acceptStat}`);
    }
    const r = reply.reader;
    const status = r.uint32();
    const tag = r.string();
    const count = r.uint32();
    const results: OpResult[] = [];
    for (let i = 0; i < count; i++) {
      const op = r.uint32();
      const opStatus = r.uint32();
      const spec = specs[i];
      const result: OpResult = { op, status: opStatus };
      if (opStatus === 0 && spec?.decode) result.value = spec.decode(r);
      results.push(result);
    }
    if (!r.done()) throw new Error(`${r.remaining()} undecoded bytes in reply`);
    return { status, tag, results };
  }

  /** SETCLIENTID + SETCLIENTID_CONFIRM for a fresh client identity. */
  async session(id = randomBytes(8)): Promise<bigint> {
    const set = await this.compound([ops.setclientid(id, randomBytes(8))]);
    if (set.status !== 0) throw new Error(`setclientid ${set.status}`);
    const { clientId, confirm } = set.results[0].value as {
      clientId: bigint;
      confirm: Buffer;
    };
    const confirmed = await this.compound([
      ops.setclientidConfirm(clientId, confirm),
    ]);
    if (confirmed.status !== 0) throw new Error(`confirm ${confirmed.status}`);
    return clientId;
  }

  /** The filehandle at a path, walking from the root. */
  async handle(path: string): Promise<Buffer> {
    const segments = path.split('/').filter(Boolean);
    const reply = await this.compound([
      ops.putrootfh(),
      ...segments.map((s) => ops.lookup(s)),
      ops.getfh(),
    ]);
    if (reply.status !== 0)
      throw new Error(`walk ${path}: status ${reply.status}`);
    return reply.results[reply.results.length - 1].value as Buffer;
  }
}
