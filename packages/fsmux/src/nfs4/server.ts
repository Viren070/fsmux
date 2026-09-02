import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { SharedFilesystem } from '../fs.js';
import { silentLogger, type Logger } from '../logger.js';
import {
  ACCEPT_PROC_UNAVAIL,
  RpcError,
  RpcServer,
  encodeAccepted,
  type RpcCall,
  type RpcPeer,
} from '../rpc.js';
import type { FsInfo } from './attrs.js';
import { compound, type CompoundEnv } from './compound.js';
import {
  NFS_PROGRAM,
  NFS_V4,
  NFSPROC4_COMPOUND,
  NFSPROC4_NULL,
} from './constants.js';
import {
  FileHandles,
  MemoryHandleStore,
  type HandleStore,
} from './filehandle.js';
import { AnonymousHandles, ClientTable, OpenTable } from './state.js';

export interface NfsServerOptions {
  fs: SharedFilesystem;
  /** Defaults to 2049. */
  port?: number;
  /** Defaults to every interface. */
  host?: string;
  /**
   * CIDR blocks allowed to connect (`10.0.0.0/8`, `::1/128`, or a bare
   * address). Empty or absent allows everyone: NFSv4 with AUTH_SYS has no
   * authentication of its own, so this list is the whole access control.
   */
  allowedClients?: string[];
  handleStore?: HandleStore;
  logger?: Logger;
  /** Reported owner of every node; defaults to 0. */
  uid?: number;
  gid?: number;
  /** Seconds; defaults to 90. */
  leaseTime?: number;
  /** Largest READ served; defaults to 1 MiB. */
  maxRead?: number;
}

const SWEEP_MS = 30_000;
const ANONYMOUS_IDLE_MS = 60_000;

export function parseAllowedClients(specs: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const raw of specs) {
    const spec = raw.trim();
    if (!spec) continue;
    const [address, prefix] = spec.split('/');
    const family = net.isIPv6(address)
      ? 'ipv6'
      : net.isIPv4(address)
        ? 'ipv4'
        : undefined;
    if (!family) throw new Error(`not an IP address or CIDR block: ${spec}`);
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

/** The IPv4 address inside a `::ffff:a.b.c.d` mapped peer, else as is. */
function plainAddress(address: string): {
  address: string;
  family: 'ipv4' | 'ipv6';
} {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return { address: mapped[1], family: 'ipv4' };
  return { address, family: net.isIPv6(address) ? 'ipv6' : 'ipv4' };
}

export class NfsServer {
  private readonly rpc: RpcServer;
  private readonly env: CompoundEnv;
  private readonly log: Logger;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(private readonly opts: NfsServerOptions) {
    this.log = opts.logger ?? silentLogger;
    const info: FsInfo = {
      leaseTime: opts.leaseTime ?? 90,
      maxRead: opts.maxRead ?? 1024 * 1024,
      maxWrite: opts.maxRead ?? 1024 * 1024,
      uid: opts.uid ?? 0,
      gid: opts.gid ?? 0,
    };
    this.env = {
      fs: opts.fs,
      handles: new FileHandles(opts.handleStore ?? new MemoryHandleStore()),
      clients: new ClientTable(),
      opens: new OpenTable(),
      anonymous: new AnonymousHandles(),
      info,
      log: this.log,
    };
    const allowed =
      opts.allowedClients && opts.allowedClients.length > 0
        ? parseAllowedClients(opts.allowedClients)
        : undefined;
    this.rpc = new RpcServer({
      logger: this.log,
      // Room for the largest READ reply's request side plus headers.
      maxRecord: 1024 * 1024,
      allow: allowed
        ? (peer) => {
            const { address, family } = plainAddress(peer.address);
            return allowed.check(address, family);
          }
        : undefined,
      program: {
        prog: NFS_PROGRAM,
        versions: [NFS_V4, NFS_V4],
        call: (call, peer) => this.call(call, peer),
      },
    });
  }

  private async call(call: RpcCall, peer: RpcPeer): Promise<Buffer> {
    switch (call.proc) {
      case NFSPROC4_NULL:
        return Buffer.alloc(0);
      case NFSPROC4_COMPOUND:
        return compound(call.args, this.env, peer);
      default:
        throw new RpcError(
          `proc ${call.proc}`,
          encodeAccepted(call.xid, ACCEPT_PROC_UNAVAIL),
        );
    }
  }

  async listen(): Promise<AddressInfo> {
    const address = await this.rpc.listen(
      this.opts.port ?? 2049,
      this.opts.host,
    );
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    this.sweeper.unref?.();
    this.log.info(
      { port: address.port, host: address.address },
      'nfs server listening',
    );
    return address;
  }

  address(): AddressInfo | null {
    return this.rpc.address();
  }

  private async sweep(): Promise<void> {
    const leaseMs = this.env.info.leaseTime * 1000;
    for (const clientId of this.env.clients.expire(leaseMs * 2)) {
      const opens = this.env.opens.removeClient(clientId);
      for (const record of opens)
        await record.handle.close().catch(() => undefined);
      this.log.debug({ opens: opens.length }, 'expired nfs client lease');
    }
    await this.env.anonymous.sweep(ANONYMOUS_IDLE_MS);
  }

  stats(): { clients: number; opens: number; anonymous: number } {
    return {
      clients: this.env.clients.size,
      opens: this.env.opens.size,
      anonymous: this.env.anonymous.size,
    };
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await this.rpc.close();
    for (const record of this.env.opens.all()) {
      this.env.opens.remove(record.stateid);
      await record.handle.close().catch(() => undefined);
    }
    await this.env.anonymous.closeAll();
  }
}
