import type { FsFileHandle, FsNode, SharedFilesystem } from '../fs.js';
import type { Logger } from '../logger.js';
import { fsErrorCode } from '../fs.js';
import type { RpcPeer } from '../rpc.js';
import { XdrError, XdrReader, XdrWriter } from '../xdr.js';
import {
  encodeAttrValues,
  readBitmap,
  supportedOf,
  writeBitmap,
  writeFattr4,
  type FsInfo,
} from './attrs.js';
import {
  ACCESS4,
  CLAIM_NULL,
  EXCLUSIVE4,
  FATTR4,
  NFS4_FHSIZE,
  NFS4_OK,
  NFS4_VERIFIER_SIZE,
  NFS4ERR,
  OP,
  OPEN4_CREATE,
  OPEN4_RESULT_LOCKTYPE_POSIX,
  OPEN4_SHARE_ACCESS_WRITE,
  OPEN_DELEGATE_NONE,
} from './constants.js';
import { BadHandleError, type FileHandles } from './filehandle.js';
import {
  isSpecialStateid,
  readStateid,
  writeStateid,
  type AnonymousHandles,
  type ClientTable,
  type OpenTable,
} from './state.js';

export interface CompoundEnv {
  fs: SharedFilesystem;
  handles: FileHandles;
  clients: ClientTable;
  opens: OpenTable;
  anonymous: AnonymousHandles;
  info: FsInfo;
  log: Logger;
}

/** An op outcome with a specific status. */
export class NfsStatusError extends Error {
  constructor(readonly status: number) {
    super(`nfs status ${status}`);
    this.name = 'NfsStatusError';
  }
}

interface FhState {
  fh: Buffer;
  node: FsNode;
}

interface CompoundState {
  current?: FhState;
  saved?: FhState;
}

interface OpContext {
  args: XdrReader;
  out: XdrWriter;
  state: CompoundState;
  env: CompoundEnv;
  peer: RpcPeer;
}

type OpHandler = (ctx: OpContext) => Promise<void>;

const MAX_CLIENT_ID = 1024;
const MAX_NAME = 4096;
const MAX_TAG = 1024;
/** Bytes of a READDIR reply that are not entries. */
const READDIR_OVERHEAD = 32;
const ZERO_VERIFIER = Buffer.alloc(NFS4_VERIFIER_SIZE);

function fail(status: number): never {
  throw new NfsStatusError(status);
}

/**
 * The status an op reports for a thrown value. `Unavailable` is an IO error
 * rather than `DELAY`: a delay makes the client retry indefinitely, so a
 * refused stream would hang the reader instead of failing it.
 */
export function statusFor(err: unknown): number {
  if (err instanceof NfsStatusError) return err.status;
  if (err instanceof BadHandleError) return NFS4ERR.BADHANDLE;
  if (err instanceof XdrError) return NFS4ERR.BADXDR;
  switch (fsErrorCode(err)) {
    case 'NotFound':
      return NFS4ERR.NOENT;
    case 'NotPermitted':
      return NFS4ERR.ACCESS;
    case 'Unavailable':
    case 'IoError':
      return NFS4ERR.IO;
  }
}

function parentPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

function current(ctx: OpContext): FhState {
  if (!ctx.state.current) fail(NFS4ERR.NOFILEHANDLE);
  return ctx.state.current;
}

function currentDir(ctx: OpContext): FhState {
  const state = current(ctx);
  if (state.node.kind === 'link') fail(NFS4ERR.SYMLINK);
  if (state.node.kind !== 'dir') fail(NFS4ERR.NOTDIR);
  return state;
}

function readName(r: XdrReader): string {
  const name = r.string(MAX_NAME);
  if (name === '') fail(NFS4ERR.INVAL);
  if (
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\0')
  ) {
    fail(NFS4ERR.BADNAME);
  }
  return name;
}

async function setCurrent(ctx: OpContext, node: FsNode): Promise<void> {
  ctx.state.current = { fh: ctx.env.handles.encode(node.path), node };
}

async function resolveHandle(ctx: OpContext, fh: Buffer): Promise<FhState> {
  const path = ctx.env.handles.decode(fh);
  if (path === undefined) fail(NFS4ERR.STALE);
  const node = await ctx.env.fs.resolve(path);
  if (!node) fail(NFS4ERR.STALE);
  return { fh, node };
}

function changeInfo(out: XdrWriter, dir: FsNode): void {
  const change = BigInt(dir.modified.getTime());
  out.bool(true).uint64(change).uint64(change);
}

async function lookupChild(
  ctx: OpContext,
  dir: FsNode,
  name: string,
): Promise<FsNode> {
  const child = await ctx.env.fs.lookup(dir, name);
  if (!child) fail(NFS4ERR.NOENT);
  return child;
}

/** Whether anything directly inside `dir` may be removed. */
async function hasRemovableChild(
  ctx: OpContext,
  dir: FsNode,
): Promise<boolean> {
  const children = await ctx.env.fs.readdir(dir);
  return children.some((child) => child.removable === true);
}

async function handleFor(ctx: OpContext, stateidRaw: XdrReader, node: FsNode) {
  const stateid = readStateid(stateidRaw);
  if (isSpecialStateid(stateid)) {
    return ctx.env.anonymous.get(node.path, () =>
      ctx.env.fs.open(node, { peer: ctx.peer.address }),
    );
  }
  const record = ctx.env.opens.get(stateid);
  if (!record || record.path !== node.path) fail(NFS4ERR.BAD_STATEID);
  ctx.env.clients.renew(record.clientId);
  return record.handle;
}

const putRoot: OpHandler = async (ctx) => {
  const root = await ctx.env.fs.resolve('/');
  if (!root) fail(NFS4ERR.SERVERFAULT);
  await setCurrent(ctx, root);
};

const OPS: Record<number, OpHandler> = {
  [OP.PUTROOTFH]: putRoot,
  [OP.PUTPUBFH]: putRoot,

  [OP.PUTFH]: async (ctx) => {
    const fh = Buffer.from(ctx.args.opaqueVar(NFS4_FHSIZE));
    ctx.state.current = await resolveHandle(ctx, fh);
  },

  [OP.GETFH]: async (ctx) => {
    ctx.out.opaqueVar(current(ctx).fh);
  },

  [OP.SAVEFH]: async (ctx) => {
    ctx.state.saved = current(ctx);
  },

  [OP.RESTOREFH]: async (ctx) => {
    if (!ctx.state.saved) fail(NFS4ERR.RESTOREFH);
    ctx.state.current = ctx.state.saved;
  },

  [OP.LOOKUP]: async (ctx) => {
    const name = readName(ctx.args);
    const { node: dir } = currentDir(ctx);
    await setCurrent(ctx, await lookupChild(ctx, dir, name));
  },

  [OP.LOOKUPP]: async (ctx) => {
    const { node } = currentDir(ctx);
    if (node.path === '/') fail(NFS4ERR.NOENT);
    const parent = await ctx.env.fs.resolve(parentPath(node.path));
    if (!parent) fail(NFS4ERR.NOENT);
    await setCurrent(ctx, parent);
  },

  [OP.GETATTR]: async (ctx) => {
    const requested = readBitmap(ctx.args);
    const { fh, node } = current(ctx);
    writeFattr4(ctx.out, requested, { node, fh }, ctx.env.info);
  },

  [OP.ACCESS]: async (ctx) => {
    const requested = ctx.args.uint32();
    const { node } = current(ctx);
    let granted = ACCESS4.READ;
    if (node.kind === 'dir') {
      granted |= ACCESS4.LOOKUP;
      if (
        requested & (ACCESS4.MODIFY | ACCESS4.DELETE | ACCESS4.EXTEND) &&
        (await hasRemovableChild(ctx, node))
      ) {
        granted |= ACCESS4.MODIFY | ACCESS4.DELETE | ACCESS4.EXTEND;
      }
    }
    const supported =
      ACCESS4.READ |
      ACCESS4.LOOKUP |
      ACCESS4.MODIFY |
      ACCESS4.EXTEND |
      ACCESS4.DELETE |
      ACCESS4.EXECUTE;
    ctx.out.uint32(requested & supported).uint32(requested & granted);
  },

  [OP.READLINK]: async (ctx) => {
    const { node } = current(ctx);
    if (node.kind === 'dir') fail(NFS4ERR.ISDIR);
    if (node.kind !== 'link') fail(NFS4ERR.INVAL);
    ctx.out.string(node.target ?? '');
  },

  [OP.READDIR]: async (ctx) => {
    const cookie = ctx.args.uint64();
    ctx.args.opaqueFixed(NFS4_VERIFIER_SIZE);
    const dircount = ctx.args.uint32();
    const maxcount = ctx.args.uint32();
    const requested = readBitmap(ctx.args);
    const { node: dir } = currentDir(ctx);
    // 0, 1 and 2 are reserved cookies; entry i is handed out as i + 3.
    if (cookie !== 0n && cookie < 3n) fail(NFS4ERR.BAD_COOKIE);
    const start = cookie === 0n ? 0 : Number(cookie - 2n);
    const entries = await ctx.env.fs.readdir(dir);
    const attrs = supportedOf(requested);
    const wantsFh = attrs.includes(FATTR4.FILEHANDLE);

    const out = ctx.out;
    out.opaqueFixed(ZERO_VERIFIER);
    let used = READDIR_OVERHEAD;
    let names = 0;
    let index = start;
    for (; index < entries.length; index++) {
      const child = entries[index];
      const nameBytes = Buffer.byteLength(child.name);
      const values = encodeAttrValues(
        attrs,
        {
          node: child,
          fh: wantsFh ? ctx.env.handles.encode(child.path) : ZERO_VERIFIER,
        },
        ctx.env.info,
      );
      const entryBytes =
        4 +
        8 +
        4 +
        ((nameBytes + 3) & ~3) +
        4 +
        attrs.length * 0 +
        bitmapBytes(attrs) +
        4 +
        ((values.length + 3) & ~3);
      if (
        used + entryBytes > maxcount ||
        (dircount > 0 && names + 8 + nameBytes > dircount)
      ) {
        if (index === start) fail(NFS4ERR.TOOSMALL);
        break;
      }
      used += entryBytes;
      names += 8 + nameBytes;
      out
        .bool(true)
        .uint64(BigInt(index + 3))
        .string(child.name);
      writeBitmap(out, attrs);
      out.opaqueVar(values);
    }
    out.bool(false).bool(index >= entries.length);
  },

  [OP.READ]: async (ctx) => {
    const { node } = current(ctx);
    const handleArgs = ctx.args;
    const stateidReader = new XdrReader(handleArgs.opaqueFixed(4 + 12), 0, 16);
    const offset = handleArgs.uint64();
    const count = handleArgs.uint32();
    if (node.kind === 'dir') fail(NFS4ERR.ISDIR);
    if (node.kind !== 'file') fail(NFS4ERR.INVAL);
    const handle = await handleFor(ctx, stateidReader, node);
    const length = Math.min(count, ctx.env.info.maxRead);
    const at = Number(offset);
    const parts =
      at >= node.size
        ? []
        : handle.readv
          ? await handle.readv(at, length)
          : [await handle.read(at, length)];
    let got = 0;
    for (const p of parts) got += p.length;
    const eof = at + got >= node.size || got < length;
    ctx.out.bool(eof).opaqueVarExternalParts(parts);
  },

  [OP.OPEN]: async (ctx) => {
    const r = ctx.args;
    r.uint32();
    const shareAccess = r.uint32();
    r.uint32();
    const clientId = r.uint64();
    r.opaqueVar(MAX_CLIENT_ID);
    const openType = r.uint32();
    if (openType === OPEN4_CREATE) {
      const mode = r.uint32();
      if (mode === EXCLUSIVE4) r.opaqueFixed(NFS4_VERIFIER_SIZE);
      else {
        readBitmap(r);
        r.opaqueVar();
      }
    }
    const claim = r.uint32();
    if (claim !== CLAIM_NULL) fail(NFS4ERR.NOTSUPP);
    const name = readName(r);

    if (!ctx.env.clients.renew(clientId)) fail(NFS4ERR.STALE_CLIENTID);
    if (openType === OPEN4_CREATE || shareAccess & OPEN4_SHARE_ACCESS_WRITE) {
      fail(NFS4ERR.ROFS);
    }
    const { node: dir } = currentDir(ctx);
    const child = await lookupChild(ctx, dir, name);
    if (child.kind === 'dir') fail(NFS4ERR.ISDIR);
    if (child.kind === 'link') fail(NFS4ERR.SYMLINK);
    const handle = await ctx.env.fs.open(child, { peer: ctx.peer.address });
    const record = ctx.env.opens.create(clientId, child.path, handle);
    await setCurrent(ctx, child);

    const out = ctx.out;
    writeStateid(out, record.stateid);
    changeInfo(out, dir);
    out.uint32(OPEN4_RESULT_LOCKTYPE_POSIX);
    writeBitmap(out, []);
    out.uint32(OPEN_DELEGATE_NONE);
  },

  [OP.OPEN_CONFIRM]: async (ctx) => {
    const stateid = readStateid(ctx.args);
    ctx.args.uint32();
    const record = ctx.env.opens.get(stateid);
    if (!record) fail(NFS4ERR.BAD_STATEID);
    record.stateid = { ...record.stateid, seqid: record.stateid.seqid + 1 };
    writeStateid(ctx.out, record.stateid);
  },

  [OP.OPEN_DOWNGRADE]: async (ctx) => {
    const stateid = readStateid(ctx.args);
    const record = ctx.env.opens.get(stateid);
    if (!record) fail(NFS4ERR.BAD_STATEID);
    writeStateid(ctx.out, record.stateid);
  },

  [OP.CLOSE]: async (ctx) => {
    ctx.args.uint32();
    const stateid = readStateid(ctx.args);
    const record = ctx.env.opens.remove(stateid);
    if (!record) fail(NFS4ERR.BAD_STATEID);
    ctx.env.clients.renew(record.clientId);
    await record.handle
      .close()
      .catch((err) =>
        ctx.env.log.debug({ err, path: record.path }, 'close failed'),
      );
    writeStateid(ctx.out, { seqid: stateid.seqid + 1, other: stateid.other });
  },

  [OP.SETCLIENTID]: async (ctx) => {
    const r = ctx.args;
    const verifier = Buffer.from(r.opaqueFixed(NFS4_VERIFIER_SIZE));
    const id = Buffer.from(r.opaqueVar(MAX_CLIENT_ID));
    r.uint32();
    r.string();
    r.string();
    r.uint32();
    const { clientId, confirm, replaced } = ctx.env.clients.setClientId(
      id,
      verifier,
    );
    if (replaced !== undefined) await dropClient(ctx, replaced);
    ctx.out.uint64(clientId).opaqueFixed(confirm);
  },

  [OP.SETCLIENTID_CONFIRM]: async (ctx) => {
    const clientId = ctx.args.uint64();
    const confirm = Buffer.from(ctx.args.opaqueFixed(NFS4_VERIFIER_SIZE));
    if (!ctx.env.clients.confirm(clientId, confirm))
      fail(NFS4ERR.STALE_CLIENTID);
  },

  [OP.RENEW]: async (ctx) => {
    const clientId = ctx.args.uint64();
    if (!ctx.env.clients.renew(clientId)) fail(NFS4ERR.STALE_CLIENTID);
  },

  [OP.RELEASE_LOCKOWNER]: async (ctx) => {
    ctx.args.uint64();
    ctx.args.opaqueVar(MAX_CLIENT_ID);
  },

  [OP.REMOVE]: async (ctx) => {
    const name = readName(ctx.args);
    const { node: dir } = currentDir(ctx);
    const child = await lookupChild(ctx, dir, name);
    if (!child.removable) fail(NFS4ERR.ACCESS);
    const outcome = await ctx.env.fs.remove(child);
    switch (outcome) {
      case 'removed':
        break;
      case 'missing':
        fail(NFS4ERR.NOENT);
      case 'denied':
        fail(NFS4ERR.ACCESS);
      case 'failed':
        fail(NFS4ERR.IO);
    }
    changeInfo(ctx.out, dir);
  },

  [OP.SECINFO]: async (ctx) => {
    const name = readName(ctx.args);
    const { node: dir } = currentDir(ctx);
    await lookupChild(ctx, dir, name);
    // AUTH_SYS then AUTH_NONE, in order of preference.
    ctx.out.uint32(2).uint32(1).uint32(0);
  },

  [OP.VERIFY]: async (ctx) => {
    if (!(await attrsMatch(ctx))) fail(NFS4ERR.NOT_SAME);
  },

  [OP.NVERIFY]: async (ctx) => {
    if (await attrsMatch(ctx)) fail(NFS4ERR.SAME);
  },

  [OP.DELEGPURGE]: async () => fail(NFS4ERR.NOTSUPP),
  [OP.DELEGRETURN]: async () => fail(NFS4ERR.NOTSUPP),
  [OP.LOCK]: async () => fail(NFS4ERR.LOCK_NOTSUPP),
  [OP.LOCKT]: async () => fail(NFS4ERR.LOCK_NOTSUPP),
  [OP.LOCKU]: async () => fail(NFS4ERR.LOCK_NOTSUPP),
  [OP.OPENATTR]: async () => fail(NFS4ERR.NOTSUPP),
  [OP.WRITE]: async () => fail(NFS4ERR.ROFS),
  [OP.CREATE]: async () => fail(NFS4ERR.ROFS),
  [OP.SETATTR]: async () => fail(NFS4ERR.ROFS),
  [OP.LINK]: async () => fail(NFS4ERR.ROFS),
  [OP.RENAME]: async () => fail(NFS4ERR.ROFS),
  [OP.COMMIT]: async () => fail(NFS4ERR.ROFS),
};

function bitmapBytes(attrs: number[]): number {
  const words = attrs.length === 0 ? 0 : (attrs[attrs.length - 1] >>> 5) + 1;
  return 4 + words * 4;
}

async function attrsMatch(ctx: OpContext): Promise<boolean> {
  const requested = readBitmap(ctx.args);
  const theirs = ctx.args.opaqueVar();
  const { fh, node } = current(ctx);
  const attrs = supportedOf(requested);
  if (attrs.length !== requested.length) fail(NFS4ERR.ATTRNOTSUPP);
  if (attrs.includes(FATTR4.RDATTR_ERROR)) fail(NFS4ERR.INVAL);
  const ours = encodeAttrValues(attrs, { node, fh }, ctx.env.info);
  return ours.equals(theirs);
}

async function dropClient(ctx: OpContext, clientId: bigint): Promise<void> {
  for (const record of ctx.env.opens.removeClient(clientId)) {
    await record.handle.close().catch(() => undefined);
  }
}

/**
 * Run one COMPOUND. Ops execute in order and stop at the first failure; the
 * reply carries every result produced up to and including that one.
 */
export async function compound(
  args: XdrReader,
  env: CompoundEnv,
  peer: RpcPeer,
): Promise<Buffer[]> {
  const tag = args.opaqueVar(MAX_TAG);
  const minor = args.uint32();
  const count = args.uint32();

  const out = new XdrWriter(1024);
  out.uint32(NFS4_OK);
  out.opaqueVar(tag);
  const countAt = out.length;
  out.uint32(0);

  if (minor !== 0) {
    out.patchUint32(0, NFS4ERR.MINOR_VERS_MISMATCH);
    return out.segments();
  }

  const state: CompoundState = {};
  let status = NFS4_OK;
  let produced = 0;
  for (let i = 0; i < count; i++) {
    const op = args.uint32();
    const handler = OPS[op];
    const resultAt = out.length;
    if (!handler) {
      out.uint32(OP.ILLEGAL).uint32(NFS4ERR.OP_ILLEGAL);
      status = NFS4ERR.OP_ILLEGAL;
      produced++;
      break;
    }
    out.uint32(op).uint32(NFS4_OK);
    const bodyAt = out.length;
    try {
      await handler({ args, out, state, env, peer });
    } catch (err) {
      status = statusFor(err);
      if (status === NFS4ERR.IO || status === NFS4ERR.SERVERFAULT) {
        env.log.warn(
          { op, path: state.current?.node.path, peer: peer.address, err },
          'nfs op failed',
        );
      }
      out.truncate(bodyAt);
      out.patchUint32(resultAt + 4, status);
      produced++;
      break;
    }
    produced++;
  }
  out.patchUint32(0, status);
  out.patchUint32(countAt, produced);
  return out.segments();
}

export type { FsFileHandle };
