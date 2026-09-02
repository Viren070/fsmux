import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { releaseBuffer } from './release.js';
import { XdrError, XdrReader, XdrWriter } from './xdr.js';
import { silentLogger, type Logger } from './logger.js';

/** ONC RPC (RFC 5531) over TCP with record marking (RFC 5531 section 11). */
export const RPC_VERSION = 2;

export const MSG_CALL = 0;
export const MSG_REPLY = 1;

export const REPLY_ACCEPTED = 0;
export const REPLY_DENIED = 1;

export const ACCEPT_SUCCESS = 0;
export const ACCEPT_PROG_UNAVAIL = 1;
export const ACCEPT_PROG_MISMATCH = 2;
export const ACCEPT_PROC_UNAVAIL = 3;
export const ACCEPT_GARBAGE_ARGS = 4;
export const ACCEPT_SYSTEM_ERR = 5;

export const REJECT_RPC_MISMATCH = 0;
export const REJECT_AUTH_ERROR = 1;

export const AUTH_NONE = 0;
export const AUTH_SYS = 1;
export const RPCSEC_GSS = 6;

/** `AUTH_TOOWEAK`: the only auth_stat we ever send. */
export const AUTH_STAT_TOOWEAK = 5;

const MAX_AUTH_BODY = 400;
const LAST_FRAGMENT = 0x80000000;

export interface AuthSys {
  stamp: number;
  machine: string;
  uid: number;
  gid: number;
  gids: number[];
}

export interface RpcCall {
  xid: number;
  prog: number;
  vers: number;
  proc: number;
  authFlavor: number;
  /** Present for `AUTH_SYS` credentials. */
  authSys?: AuthSys;
  /** Positioned at the start of the procedure arguments. */
  args: XdrReader;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly reply: Buffer,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

function parseAuthSys(body: Buffer): AuthSys {
  const r = new XdrReader(body);
  const stamp = r.uint32();
  const machine = r.string(255);
  const uid = r.uint32();
  const gid = r.uint32();
  const count = r.uint32();
  if (count > 16) throw new XdrError('too many gids');
  const gids: number[] = [];
  for (let i = 0; i < count; i++) gids.push(r.uint32());
  return { stamp, machine, uid, gid, gids };
}

/**
 * Parse one record as a call. Throws {@link RpcError} carrying the reply to
 * send when the header itself is bad, {@link XdrError} when it is truncated.
 */
export function parseCall(record: Buffer): RpcCall {
  const r = new XdrReader(record);
  const xid = r.uint32();
  const msgType = r.uint32();
  if (msgType !== MSG_CALL) throw new XdrError('not a call');
  const rpcVersion = r.uint32();
  if (rpcVersion !== RPC_VERSION) {
    throw new RpcError(
      `rpc version ${rpcVersion}`,
      encodeDeniedMismatch(xid, RPC_VERSION, RPC_VERSION),
    );
  }
  const prog = r.uint32();
  const vers = r.uint32();
  const proc = r.uint32();
  const authFlavor = r.uint32();
  const authBody = r.opaqueVar(MAX_AUTH_BODY);
  r.uint32();
  r.opaqueVar(MAX_AUTH_BODY);
  let authSys: AuthSys | undefined;
  if (authFlavor === AUTH_SYS) authSys = parseAuthSys(authBody);
  return { xid, prog, vers, proc, authFlavor, authSys, args: r };
}

function replyHeader(xid: number, w: XdrWriter): void {
  w.uint32(xid).uint32(MSG_REPLY);
}

/** Header of an accepted reply, results to follow. */
export function beginAcceptedReply(
  xid: number,
  acceptStat = ACCEPT_SUCCESS,
): XdrWriter {
  const w = new XdrWriter();
  replyHeader(xid, w);
  w.uint32(REPLY_ACCEPTED);
  w.uint32(AUTH_NONE).opaqueVar(Buffer.alloc(0));
  w.uint32(acceptStat);
  return w;
}

export function encodeAccepted(xid: number, acceptStat: number): Buffer {
  return beginAcceptedReply(xid, acceptStat).toBuffer();
}

export function encodeProgMismatch(
  xid: number,
  low: number,
  high: number,
): Buffer {
  return beginAcceptedReply(xid, ACCEPT_PROG_MISMATCH)
    .uint32(low)
    .uint32(high)
    .toBuffer();
}

export function encodeDeniedMismatch(
  xid: number,
  low: number,
  high: number,
): Buffer {
  const w = new XdrWriter();
  replyHeader(xid, w);
  return w
    .uint32(REPLY_DENIED)
    .uint32(REJECT_RPC_MISMATCH)
    .uint32(low)
    .uint32(high)
    .toBuffer();
}

export function encodeDeniedAuth(xid: number, authStat: number): Buffer {
  const w = new XdrWriter();
  replyHeader(xid, w);
  return w
    .uint32(REPLY_DENIED)
    .uint32(REJECT_AUTH_ERROR)
    .uint32(authStat)
    .toBuffer();
}

/** One record with a single last fragment. */
export function frameRecord(payload: Uint8Array): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE((payload.length | LAST_FRAGMENT) >>> 0, 0);
  return Buffer.concat([header, payload]);
}

/** One record written as scattered parts, so payloads are never joined. */
function writeRecord(socket: net.Socket, parts: Buffer[]): void {
  let total = 0;
  for (const p of parts) total += p.length;
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE((total | LAST_FRAGMENT) >>> 0, 0);
  socket.cork();
  socket.write(header);
  for (let i = 0; i + 1 < parts.length; i++) socket.write(parts[i]);
  // Write callbacks fire in order, so the last one means every part has been
  // handed to the OS (or the socket died) and pooled payloads may be reused.
  socket.write(parts[parts.length - 1], () => {
    for (const p of parts) releaseBuffer(p);
  });
  socket.uncork();
}

/**
 * Reassembles records from a byte stream. Fragments of one record are joined;
 * a record larger than `maxRecord` throws, which the connection treats as
 * fatal.
 */
export class RecordReader {
  private pending: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;

  constructor(
    private readonly maxRecord: number,
    private readonly onRecord: (record: Buffer) => void,
  ) {}

  push(data: Buffer): void {
    this.pending =
      this.pending.length === 0 ? data : Buffer.concat([this.pending, data]);
    for (;;) {
      if (this.pending.length < 4) return;
      const header = this.pending.readUInt32BE(0);
      const last = (header & LAST_FRAGMENT) !== 0;
      const length = header & ~LAST_FRAGMENT;
      if (this.fragmentBytes + length > this.maxRecord) {
        throw new XdrError(`record exceeds ${this.maxRecord} bytes`);
      }
      if (this.pending.length < 4 + length) return;
      // Copy: the pending buffer is reused for the next chunk.
      this.fragments.push(Buffer.from(this.pending.subarray(4, 4 + length)));
      this.fragmentBytes += length;
      this.pending = this.pending.subarray(4 + length);
      if (last) {
        const record =
          this.fragments.length === 1
            ? this.fragments[0]
            : Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentBytes = 0;
        this.onRecord(record);
      }
    }
  }
}

export interface RpcPeer {
  address: string;
  port: number;
}

export interface RpcProgram {
  prog: number;
  /** Inclusive version range served. */
  versions: [number, number];
  /**
   * Results for one call, without the RPC reply header, as one buffer or as
   * segments written to the socket without joining. Throw {@link RpcError}
   * to send a specific reply instead.
   */
  call(call: RpcCall, peer: RpcPeer): Promise<Buffer | Buffer[]>;
}

export interface RpcServerOptions {
  program: RpcProgram;
  /** Largest inbound record accepted; defaults to 1 MiB. */
  maxRecord?: number;
  /** Refuses a connection before any byte is read. */
  allow?: (peer: RpcPeer) => boolean;
  /** Calls in flight per connection before the socket is paused. */
  maxInflight?: number;
  logger?: Logger;
}

export class RpcServer {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly log: Logger;

  constructor(private readonly opts: RpcServerOptions) {
    this.log = opts.logger ?? silentLogger;
    this.server = net.createServer({ noDelay: true }, (socket) =>
      this.accept(socket),
    );
  }

  listen(port: number, host?: string): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve(this.server.address() as AddressInfo);
      });
    });
  }

  address(): AddressInfo | null {
    return this.server.address() as AddressInfo | null;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: net.Socket): void {
    const peer: RpcPeer = {
      address: socket.remoteAddress ?? '',
      port: socket.remotePort ?? 0,
    };
    if (this.opts.allow && !this.opts.allow(peer)) {
      this.log.warn(
        { peer: peer.address },
        'connection refused by client list',
      );
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setKeepAlive(true, 60_000);
    const maxInflight = this.opts.maxInflight ?? 64;
    let inflight = 0;
    const reader = new RecordReader(
      this.opts.maxRecord ?? 1024 * 1024,
      (record) => {
        inflight++;
        if (inflight >= maxInflight) socket.pause();
        void this.dispatch(record, peer)
          .then((reply) => {
            const parts = Array.isArray(reply) ? reply : [reply];
            if (socket.destroyed) {
              for (const p of parts) releaseBuffer(p);
              return;
            }
            writeRecord(socket, parts);
          })
          .finally(() => {
            inflight--;
            if (inflight < maxInflight / 2 && socket.isPaused()) {
              socket.resume();
            }
          });
      },
    );
    socket.on('data', (data) => {
      try {
        reader.push(data);
      } catch (err) {
        this.log.warn(
          { peer: peer.address, err: (err as Error).message },
          'dropping connection: bad record',
        );
        socket.destroy();
      }
    });
    socket.on('error', (err) => {
      this.log.debug({ peer: peer.address, err: err.message }, 'socket error');
    });
    socket.on('close', () => this.sockets.delete(socket));
  }

  private async dispatch(
    record: Buffer,
    peer: RpcPeer,
  ): Promise<Buffer | Buffer[]> {
    let call: RpcCall;
    try {
      call = parseCall(record);
    } catch (err) {
      if (err instanceof RpcError) return err.reply;
      // Without a parsable xid there is nothing to answer to.
      throw err;
    }
    const { program } = this.opts;
    if (call.prog !== program.prog) {
      return encodeAccepted(call.xid, ACCEPT_PROG_UNAVAIL);
    }
    if (call.vers < program.versions[0] || call.vers > program.versions[1]) {
      return encodeProgMismatch(
        call.xid,
        program.versions[0],
        program.versions[1],
      );
    }
    if (call.authFlavor !== AUTH_NONE && call.authFlavor !== AUTH_SYS) {
      return encodeDeniedAuth(call.xid, AUTH_STAT_TOOWEAK);
    }
    try {
      const results = await program.call(call, peer);
      const header = beginAcceptedReply(call.xid).toBuffer();
      return Array.isArray(results) ? [header, ...results] : [header, results];
    } catch (err) {
      if (err instanceof RpcError) return err.reply;
      if (err instanceof XdrError) {
        return encodeAccepted(call.xid, ACCEPT_GARBAGE_ARGS);
      }
      this.log.error(
        { peer: peer.address, proc: call.proc, err },
        'unhandled error in rpc procedure',
      );
      return encodeAccepted(call.xid, ACCEPT_SYSTEM_ERR);
    }
  }
}
