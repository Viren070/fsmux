import type { Readable } from 'node:stream';

/**
 * The filesystem a protocol server exports. Protocol-neutral by design: the
 * same tree is meant to sit behind NFS, SMB or a local mount, so nothing here
 * names a wire concept. Errors thrown by an implementation carry a `code`
 * from {@link FsErrorCode}; each server maps it to its own status.
 */
export type FsNodeKind = 'dir' | 'file' | 'link';

export interface FsNode {
  kind: FsNodeKind;
  /** Absolute path within the export, `/` for the root. */
  path: string;
  name: string;
  /** Stable 64-bit identity (inode, fileid). */
  id: bigint;
  /** Full `st_mode`, type bits included. */
  mode: number;
  nlink: number;
  size: number;
  modified: Date;
  /** Link target as the client should see it; links only. */
  target?: string;
  /** Whether a client may remove this node. */
  removable?: boolean;
  /** Strong validator for a file's bytes; derived from the stat when absent. */
  etag?: string;
  /** Media type of a file's bytes; `application/octet-stream` when absent. */
  contentType?: string;
}

export interface FsByteRange {
  start?: number;
  /** Exclusive end; undefined for an open-ended range. */
  endExclusive?: number;
  /** Last N bytes; overrides start/end. */
  suffixLength?: number;
}

export interface FsOpenedStream {
  /** Produces exactly `[start, end)`. */
  stream: Readable;
  size: number;
  start: number;
  /** Exclusive. */
  end: number;
}

/** Positional reads against one held session. */
export interface FsFileHandle {
  /** Bytes at `[offset, offset + length)`, shorter only at end of file. */
  read(offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

export type FsRemoveOutcome = 'removed' | 'missing' | 'denied' | 'failed';

export type FsErrorCode =
  'NotFound' | 'NotPermitted' | 'Unavailable' | 'IoError';

export interface FsOpenOptions {
  /** Address of the client reading the file, for attribution. */
  peer?: string;
}

export interface SharedFilesystem {
  /** The node at an absolute path, or undefined when nothing is there. */
  resolve(path: string): Promise<FsNode | undefined>;
  lookup(dir: FsNode, name: string): Promise<FsNode | undefined>;
  readdir(dir: FsNode): Promise<FsNode[]>;
  open(file: FsNode, opts?: FsOpenOptions): Promise<FsFileHandle>;
  /**
   * One byte range as a stream, for protocols that serve a whole range at
   * once. Optional: without it the range is read through a handle.
   */
  openStream?(
    file: FsNode,
    range: FsByteRange | undefined,
    signal: AbortSignal,
    opts?: FsOpenOptions,
  ): Promise<FsOpenedStream>;
  remove(node: FsNode): Promise<FsRemoveOutcome>;
}

export class FsError extends Error {
  readonly code: FsErrorCode;

  constructor(
    code: FsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'FsError';
    this.code = code;
  }
}

const CODES: ReadonlySet<string> = new Set([
  'NotFound',
  'NotPermitted',
  'Unavailable',
  'IoError',
]);

/** The vocabulary code of any thrown value, `IoError` when it has none. */
export function fsErrorCode(err: unknown): FsErrorCode {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && CODES.has(code)
    ? (code as FsErrorCode)
    : 'IoError';
}

/** The half-open byte window a range selects within `size`. */
export function resolveRange(
  range: FsByteRange | undefined,
  size: number,
): { start: number; end: number } {
  if (!range) return { start: 0, end: size };
  if (range.suffixLength !== undefined) {
    return { start: Math.max(0, size - range.suffixLength), end: size };
  }
  const start = range.start ?? 0;
  const end = Math.min(range.endExclusive ?? size, size);
  return { start, end: Math.max(start, end) };
}
