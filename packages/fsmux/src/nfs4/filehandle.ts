import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NFS4_FHSIZE } from './constants.js';

/**
 * Filehandles that outlive the process. A path short enough to fit is the
 * handle itself; a longer one is replaced by its hash, with the path kept in
 * the store so the handle can be reversed after a restart. A hash whose path
 * was never stored (or was lost) is stale, which a client recovers from by
 * walking the path again.
 */
const KIND_PATH = 0;
const KIND_HASH = 1;
const HASH_BYTES = 8;
const MAX_INLINE = NFS4_FHSIZE - 1;

export class BadHandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadHandleError';
  }
}

export interface HandleStore {
  get(id: bigint): string | undefined;
  set(id: bigint, path: string): void;
}

export class MemoryHandleStore implements HandleStore {
  private readonly paths = new Map<bigint, string>();

  constructor(private readonly maxEntries = 100_000) {}

  get(id: bigint): string | undefined {
    return this.paths.get(id);
  }

  set(id: bigint, path: string): void {
    if (this.paths.has(id)) return;
    if (this.paths.size >= this.maxEntries) {
      const oldest = this.paths.keys().next().value;
      if (oldest !== undefined) this.paths.delete(oldest);
    }
    this.paths.set(id, path);
  }

  get size(): number {
    return this.paths.size;
  }

  entries(): IterableIterator<[bigint, string]> {
    return this.paths.entries();
  }
}

/** A JSON file of `{ "<hex id>": path }`, written a moment after changes. */
export class JsonFileHandleStore implements HandleStore {
  private readonly memory: MemoryHandleStore;
  private dirty = false;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly opts: { maxEntries?: number; flushDelayMs?: number } = {},
  ) {
    this.memory = new MemoryHandleStore(opts.maxEntries);
  }

  async load(): Promise<number> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
    const entries = JSON.parse(text) as Record<string, string>;
    let n = 0;
    for (const [hex, path] of Object.entries(entries)) {
      if (typeof path !== 'string') continue;
      this.memory.set(BigInt(`0x${hex}`), path);
      n++;
    }
    return n;
  }

  get(id: bigint): string | undefined {
    return this.memory.get(id);
  }

  set(id: bigint, path: string): void {
    if (this.memory.get(id) !== undefined) return;
    this.memory.set(id, path);
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.opts.flushDelayMs ?? 1000);
    this.timer.unref?.();
  }

  flush(): Promise<void> {
    if (!this.dirty) return this.writing;
    this.dirty = false;
    this.writing = this.writing.then(async () => {
      const out: Record<string, string> = {};
      for (const [id, path] of this.memory.entries()) {
        out[id.toString(16)] = path;
      }
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(out));
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
  }
}

export function pathHandleId(path: string): bigint {
  return createHash('sha1').update(path).digest().readBigUInt64BE(0);
}

export class FileHandles {
  constructor(private readonly store: HandleStore = new MemoryHandleStore()) {}

  encode(path: string): Buffer {
    const bytes = Buffer.from(path, 'utf8');
    if (bytes.length <= MAX_INLINE) {
      return Buffer.concat([Buffer.from([KIND_PATH]), bytes]);
    }
    const id = pathHandleId(path);
    this.store.set(id, path);
    const fh = Buffer.allocUnsafe(1 + HASH_BYTES);
    fh[0] = KIND_HASH;
    fh.writeBigUInt64BE(id, 1);
    return fh;
  }

  /** The path, or undefined for a hash this server no longer knows. */
  decode(fh: Buffer): string | undefined {
    if (fh.length === 0 || fh.length > NFS4_FHSIZE) {
      throw new BadHandleError(`handle of ${fh.length} bytes`);
    }
    switch (fh[0]) {
      case KIND_PATH: {
        const path = fh.subarray(1).toString('utf8');
        if (path !== '/' && (!path.startsWith('/') || path.endsWith('/'))) {
          throw new BadHandleError('malformed inline path');
        }
        return path;
      }
      case KIND_HASH:
        if (fh.length !== 1 + HASH_BYTES) {
          throw new BadHandleError('malformed hashed handle');
        }
        return this.store.get(fh.readBigUInt64BE(1));
      default:
        throw new BadHandleError(`unknown handle kind ${fh[0]}`);
    }
  }
}
