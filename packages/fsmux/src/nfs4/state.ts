import { randomBytes } from 'node:crypto';
import type { FsFileHandle } from '../fs.js';
import type { XdrReader, XdrWriter } from '../xdr.js';
import { NFS4_OTHER_SIZE } from './constants.js';

export interface Stateid {
  seqid: number;
  /** 12 bytes. */
  other: Buffer;
}

export function readStateid(r: XdrReader): Stateid {
  const seqid = r.uint32();
  const other = Buffer.from(r.opaqueFixed(NFS4_OTHER_SIZE));
  return { seqid, other };
}

export function writeStateid(w: XdrWriter, s: Stateid): void {
  w.uint32(s.seqid).opaqueFixed(s.other);
}

/** The anonymous (all zero) and read-bypass (all one) stateids. */
export function isSpecialStateid(s: Stateid): boolean {
  const zero = s.other.every((b) => b === 0);
  const ones = s.other.every((b) => b === 0xff);
  return (zero && s.seqid === 0) || (ones && s.seqid === 0xffffffff);
}

interface ClientRecord {
  clientId: bigint;
  ownerKey: string;
  verifier: Buffer;
  confirm: Buffer;
  confirmed: boolean;
  lastSeen: number;
}

/**
 * `SETCLIENTID` state. A client is identified by the opaque id it chose; a
 * new verifier for a known id means it rebooted and its old state is gone.
 */
export class ClientTable {
  private readonly byId = new Map<bigint, ClientRecord>();
  private readonly byOwner = new Map<string, ClientRecord>();

  setClientId(
    id: Buffer,
    verifier: Buffer,
    now = Date.now(),
  ): { clientId: bigint; confirm: Buffer; replaced?: bigint } {
    const ownerKey = id.toString('hex');
    const existing = this.byOwner.get(ownerKey);
    let replaced: bigint | undefined;
    if (existing && existing.confirmed && existing.verifier.equals(verifier)) {
      existing.confirm = randomBytes(8);
      existing.lastSeen = now;
      return { clientId: existing.clientId, confirm: existing.confirm };
    }
    if (existing) {
      this.byId.delete(existing.clientId);
      if (existing.confirmed) replaced = existing.clientId;
    }
    const record: ClientRecord = {
      clientId: randomBytes(8).readBigUInt64BE(0),
      ownerKey,
      verifier: Buffer.from(verifier),
      confirm: randomBytes(8),
      confirmed: false,
      lastSeen: now,
    };
    this.byId.set(record.clientId, record);
    this.byOwner.set(ownerKey, record);
    return { clientId: record.clientId, confirm: record.confirm, replaced };
  }

  confirm(clientId: bigint, confirm: Buffer, now = Date.now()): boolean {
    const record = this.byId.get(clientId);
    if (!record || !record.confirm.equals(confirm)) return false;
    record.confirmed = true;
    record.lastSeen = now;
    return true;
  }

  /** Renew the lease; false for an unknown or unconfirmed client. */
  renew(clientId: bigint, now = Date.now()): boolean {
    const record = this.byId.get(clientId);
    if (!record || !record.confirmed) return false;
    record.lastSeen = now;
    return true;
  }

  has(clientId: bigint): boolean {
    return this.byId.get(clientId)?.confirmed === true;
  }

  /** Clients silent for longer than `idleMs`, removed as they are returned. */
  expire(idleMs: number, now = Date.now()): bigint[] {
    const gone: bigint[] = [];
    for (const record of this.byId.values()) {
      if (now - record.lastSeen <= idleMs) continue;
      this.byId.delete(record.clientId);
      this.byOwner.delete(record.ownerKey);
      gone.push(record.clientId);
    }
    return gone;
  }

  get size(): number {
    return this.byId.size;
  }
}

export interface OpenRecord {
  stateid: Stateid;
  clientId: bigint;
  path: string;
  handle: FsFileHandle;
  lastUsed: number;
}

/** Files a client has opened, keyed by the `other` part of the stateid. */
export class OpenTable {
  private readonly opens = new Map<string, OpenRecord>();

  create(
    clientId: bigint,
    path: string,
    handle: FsFileHandle,
    now = Date.now(),
  ): OpenRecord {
    const stateid: Stateid = { seqid: 1, other: randomBytes(NFS4_OTHER_SIZE) };
    const record: OpenRecord = {
      stateid,
      clientId,
      path,
      handle,
      lastUsed: now,
    };
    this.opens.set(stateid.other.toString('hex'), record);
    return record;
  }

  get(stateid: Stateid, now = Date.now()): OpenRecord | undefined {
    const record = this.opens.get(stateid.other.toString('hex'));
    if (record) record.lastUsed = now;
    return record;
  }

  /** Forget the open; the caller closes the handle. */
  remove(stateid: Stateid): OpenRecord | undefined {
    const key = stateid.other.toString('hex');
    const record = this.opens.get(key);
    if (record) this.opens.delete(key);
    return record;
  }

  removeClient(clientId: bigint): OpenRecord[] {
    const removed: OpenRecord[] = [];
    for (const [key, record] of this.opens) {
      if (record.clientId !== clientId) continue;
      this.opens.delete(key);
      removed.push(record);
    }
    return removed;
  }

  all(): OpenRecord[] {
    return [...this.opens.values()];
  }

  get size(): number {
    return this.opens.size;
  }
}

/**
 * Handles for reads that carry a special stateid (no OPEN), one per file,
 * dropped after a quiet spell.
 */
export class AnonymousHandles {
  private readonly handles = new Map<
    string,
    { handle: FsFileHandle; lastUsed: number }
  >();

  constructor(private readonly maxEntries = 64) {}

  async get(
    path: string,
    open: () => Promise<FsFileHandle>,
    now = Date.now(),
  ): Promise<FsFileHandle> {
    const hit = this.handles.get(path);
    if (hit) {
      hit.lastUsed = now;
      return hit.handle;
    }
    const handle = await open();
    if (this.handles.size >= this.maxEntries) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [key, entry] of this.handles) {
        if (entry.lastUsed < oldest) {
          oldest = entry.lastUsed;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) {
        const evicted = this.handles.get(oldestKey)!;
        this.handles.delete(oldestKey);
        void evicted.handle.close().catch(() => undefined);
      }
    }
    this.handles.set(path, { handle, lastUsed: now });
    return handle;
  }

  /** Close handles idle longer than `idleMs`. */
  async sweep(idleMs: number, now = Date.now()): Promise<number> {
    let closed = 0;
    for (const [key, entry] of this.handles) {
      if (now - entry.lastUsed <= idleMs) continue;
      this.handles.delete(key);
      await entry.handle.close().catch(() => undefined);
      closed++;
    }
    return closed;
  }

  async closeAll(): Promise<void> {
    const entries = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(
      entries.map((e) => e.handle.close().catch(() => undefined)),
    );
  }

  get size(): number {
    return this.handles.size;
  }
}
