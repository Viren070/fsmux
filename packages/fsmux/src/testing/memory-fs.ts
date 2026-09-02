import { Readable } from 'node:stream';
import {
  FsError,
  resolveRange,
  type FsByteRange,
  type FsErrorCode,
  type FsFileHandle,
  type FsNode,
  type FsOpenedStream,
  type FsOpenOptions,
  type FsRemoveOutcome,
  type SharedFilesystem,
} from '../fs.js';

export interface MemoryFile {
  data: Buffer;
  removable?: boolean;
  removeOutcome?: FsRemoveOutcome;
  etag?: string;
  /** Throw this code from `open`. */
  failOpen?: FsErrorCode;
  /** Throw from `read` at or past this offset. */
  failReadAt?: number;
}

export interface MemoryDir {
  entries: MemorySpec;
  removable?: boolean;
  removeOutcome?: FsRemoveOutcome;
}

export interface MemoryLink {
  link: string;
  removable?: boolean;
}

export type MemorySpec = {
  [name: string]: MemorySpec | MemoryFile | MemoryDir | string | MemoryLink;
};

export interface MemoryFsOptions {
  modified?: Date;
  /** Implement `openStream` too, so range serving skips the handle path. */
  withStreams?: boolean;
}

interface Entry {
  node: FsNode;
  file?: MemoryFile;
  children?: string[];
}

const CONTENT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  mkv: 'video/x-matroska',
  bin: 'application/octet-stream',
};

const STREAM_CHUNK = 64 * 1024;

export function dir(
  entries: MemorySpec,
  opts: Omit<MemoryDir, 'entries'> = {},
): MemoryDir {
  return { entries, ...opts };
}

export function file(
  data: Buffer | string,
  opts: Omit<MemoryFile, 'data'> = {},
): MemoryFile {
  return { data: Buffer.isBuffer(data) ? data : Buffer.from(data), ...opts };
}

function isFile(v: unknown): v is MemoryFile {
  return (
    typeof v === 'object' &&
    v !== null &&
    Buffer.isBuffer((v as MemoryFile).data)
  );
}

function isDir(v: unknown): v is MemoryDir {
  return typeof v === 'object' && v !== null && 'entries' in (v as MemoryDir);
}

function isLink(v: unknown): v is MemoryLink {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { link?: unknown }).link === 'string'
  );
}

function joinPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/** A tree in memory that records what the server did to it. */
export class MemoryFs implements SharedFilesystem {
  private readonly entries = new Map<string, Entry>();
  readonly modified: Date;
  readonly opened: string[] = [];
  readonly openPeers: (string | undefined)[] = [];
  readonly closed: string[] = [];
  readonly reads: { path: string; offset: number; length: number }[] = [];
  readonly streams: { path: string; start: number; end: number }[] = [];
  readonly removed: string[] = [];
  private nextId = 2n;
  openStream?: SharedFilesystem['openStream'];

  constructor(spec: MemorySpec, opts: MemoryFsOptions = {}) {
    this.modified = opts.modified ?? new Date('2024-06-01T12:00:00Z');
    this.addDir('/', '', spec, undefined, 1n);
    if (opts.withStreams) {
      this.openStream = (node, range, signal, o) =>
        this.streamOf(node, range, signal, o);
    }
  }

  private addDir(
    path: string,
    name: string,
    spec: MemorySpec,
    opts?: Omit<MemoryDir, 'entries'>,
    id?: bigint,
  ): void {
    const names = Object.keys(spec);
    this.entries.set(path, {
      node: {
        kind: 'dir',
        path,
        name,
        id: id ?? this.nextId++,
        mode: 0o040555,
        nlink: 2,
        size: 0,
        modified: this.modified,
        removable: opts?.removable,
      },
      children: names,
    });
    if (opts?.removeOutcome) this.dirOutcomes.set(path, opts.removeOutcome);
    for (const child of names) this.addEntry(path, child, spec[child]);
  }

  private addEntry(parent: string, name: string, value: MemorySpec[string]) {
    const childPath = joinPath(parent, name);
    if (typeof value === 'string') {
      this.addFile(childPath, name, file(value));
    } else if (isFile(value)) {
      this.addFile(childPath, name, value);
    } else if (isLink(value)) {
      this.entries.set(childPath, {
        node: {
          kind: 'link',
          path: childPath,
          name,
          id: this.nextId++,
          mode: 0o120777,
          nlink: 1,
          size: Buffer.byteLength(value.link),
          modified: this.modified,
          target: value.link,
          removable: value.removable,
        },
      });
    } else if (isDir(value)) {
      this.addDir(childPath, name, value.entries, value);
    } else {
      this.addDir(childPath, name, value as MemorySpec);
    }
  }

  private addFile(path: string, name: string, spec: MemoryFile): void {
    const ext = name.split('.').pop() ?? '';
    this.entries.set(path, {
      node: {
        kind: 'file',
        path,
        name,
        id: this.nextId++,
        mode: 0o100644,
        nlink: 1,
        size: spec.data.length,
        modified: this.modified,
        removable: spec.removable,
        etag: spec.etag,
        contentType: CONTENT_TYPES[ext],
      },
      file: spec,
    });
  }

  node(path: string): FsNode {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`no such test node ${path}`);
    return entry.node;
  }

  /** Add an entry under an existing directory after construction. */
  add(parent: string, name: string, value: MemorySpec[string]): FsNode {
    const dirEntry = this.entries.get(parent);
    if (!dirEntry?.children) throw new Error(`no such test dir ${parent}`);
    this.addEntry(parent, name, value);
    dirEntry.children.push(name);
    return this.node(joinPath(parent, name));
  }

  /** Move a node's modified date, the way a changed listing would. */
  touch(path: string, modified: Date): void {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`no such test node ${path}`);
    entry.node = { ...entry.node, modified };
  }

  async resolve(path: string): Promise<FsNode | undefined> {
    return this.entries.get(path)?.node;
  }

  async lookup(dirNode: FsNode, name: string): Promise<FsNode | undefined> {
    const entry = this.entries.get(dirNode.path);
    if (!entry?.children?.includes(name)) return undefined;
    return this.entries.get(joinPath(dirNode.path, name))?.node;
  }

  async readdir(dirNode: FsNode): Promise<FsNode[]> {
    const entry = this.entries.get(dirNode.path);
    if (!entry?.children) throw new FsError('NotFound', 'gone');
    return entry.children.map(
      (name) => this.entries.get(joinPath(dirNode.path, name))!.node,
    );
  }

  private fileSpec(fileNode: FsNode): MemoryFile {
    const entry = this.entries.get(fileNode.path);
    if (!entry?.file) throw new FsError('NotFound', 'gone');
    if (entry.file.failOpen) {
      throw new FsError(
        entry.file.failOpen,
        `open refused: ${entry.file.failOpen}`,
      );
    }
    return entry.file;
  }

  async open(fileNode: FsNode, opts?: FsOpenOptions): Promise<FsFileHandle> {
    const spec = this.fileSpec(fileNode);
    this.opened.push(fileNode.path);
    this.openPeers.push(opts?.peer);
    let closed = false;
    return {
      read: async (offset, length) => {
        if (closed) throw new FsError('IoError', 'closed');
        this.reads.push({ path: fileNode.path, offset, length });
        if (
          spec.failReadAt !== undefined &&
          offset + length > spec.failReadAt
        ) {
          throw new FsError('IoError', 'read failed');
        }
        return Buffer.from(spec.data.subarray(offset, offset + length));
      },
      close: async () => {
        closed = true;
        this.closed.push(fileNode.path);
      },
    };
  }

  private async streamOf(
    fileNode: FsNode,
    range: FsByteRange | undefined,
    signal: AbortSignal,
    opts?: FsOpenOptions,
  ): Promise<FsOpenedStream> {
    const spec = this.fileSpec(fileNode);
    this.openPeers.push(opts?.peer);
    const { start, end } = resolveRange(range, spec.data.length);
    this.streams.push({ path: fileNode.path, start, end });
    async function* chunks() {
      for (let pos = start; pos < end; pos += STREAM_CHUNK) {
        if (signal.aborted) return;
        const stop = Math.min(end, pos + STREAM_CHUNK);
        if (spec.failReadAt !== undefined && stop > spec.failReadAt) {
          throw new FsError('IoError', 'stream failed');
        }
        yield spec.data.subarray(pos, stop);
      }
    }
    return {
      stream: Readable.from(chunks()),
      size: spec.data.length,
      start,
      end,
    };
  }

  async remove(node: FsNode): Promise<FsRemoveOutcome> {
    const entry = this.entries.get(node.path);
    if (!entry) return 'missing';
    const outcome =
      entry.file?.removeOutcome ??
      (entry.children ? this.dirOutcome(node.path) : undefined) ??
      'removed';
    if (outcome === 'removed') {
      this.entries.delete(node.path);
      const parent = this.entries.get(
        node.path.slice(0, node.path.lastIndexOf('/')) || '/',
      );
      if (parent?.children)
        parent.children = parent.children.filter((n) => n !== node.name);
      this.removed.push(node.path);
    }
    return outcome;
  }

  private readonly dirOutcomes = new Map<string, FsRemoveOutcome>();

  setDirOutcome(path: string, outcome: FsRemoveOutcome): void {
    this.dirOutcomes.set(path, outcome);
  }

  private dirOutcome(path: string): FsRemoveOutcome | undefined {
    return this.dirOutcomes.get(path);
  }
}
