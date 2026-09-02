import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type FsFileHandle,
  type FsNode,
  type SharedFilesystem,
} from '@viren070/fsmux';
import { releaseBuffer } from '@viren070/fsmux';
import { silentLogger, type Logger } from './logger.js';
import { kindOf, toFuseAttr, KIND_DIR, type AttrOptions } from './attrs.js';
import { loadNativeBinding, type NativeBinding } from './binding.js';
import {
  EACCES,
  EBADF,
  EINVAL,
  EIO,
  EISDIR,
  ENOENT,
  ENOSYS,
  ENOTDIR,
  errnoOf,
  FuseErrno,
} from './errno.js';
import { InodeTable } from './inodes.js';
import { clearMountpoint } from './mountpoint.js';
import type {
  FuseDirEntry,
  FuseDirPlusEntry,
  FuseMount as NativeMount,
  FuseRequest,
} from './native.js';

const run = promisify(execFile);

export interface FuseMountOptions {
  /** Absolute path; created when missing, must be an empty directory. */
  mountPath: string;
  fs: SharedFilesystem;
  /** `fsname` and `subtype` in /proc/mounts. */
  fsName?: string;
  /** Let users other than the one running this process read the mount. */
  allowOther?: boolean;
  /** Unmount through fusermount when the process dies; not available as root without it. */
  autoUnmount?: boolean;
  /** How long the kernel may trust a name or attributes without asking again. */
  entryTtlMs?: number;
  attrTtlMs?: number;
  /**
   * TTL for directory replies (default 15 s). Directories change rarely and
   * changes are invalidation-pushed, so they can outlive the file TTLs. A
   * failed lookup is cached as a negative entry for `entryTtlMs`.
   */
  dirTtlMs?: number;
  /** Owner reported by stat. Mode bits are informational either way. */
  uid?: number;
  gid?: number;
  /** Address opens are attributed to, since a local mount has no peer. */
  peer?: string;
  /** Entries handed to the kernel per readdir round trip. */
  readdirBatch?: number;
  logger?: Logger;
}

export interface FuseMountStats {
  inodes: number;
  openFiles: number;
  pendingRequests: number;
  requests: number;
  errors: number;
}

export interface FuseMount {
  readonly mountPath: string;
  readonly mounted: boolean;
  unmount(): Promise<void>;
  /** A directory's listing changed: forget its attributes and every cached name under it. */
  invalidateDir(dirPath: string): void;
  /** One name under a directory is gone (or newly there). */
  invalidateEntry(dirPath: string, name: string): void;
  stats(): FuseMountStats;
}

/** The binding is missing or this host cannot mount; `reason` says which. */
export class FuseUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'FuseUnavailableError';
  }
}

const DEFAULT_FS_NAME = 'fsmux';
const DEFAULT_TTL_MS = 1_000;
const DEFAULT_DIR_TTL_MS = 15_000;
const DEFAULT_BLKSIZE = 128 * 1024;
const DEFAULT_READDIR_BATCH = 512;

function normalizePath(p: string): string {
  const segments = p.split('/').filter(Boolean);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function parentPath(p: string): string {
  const cut = p.lastIndexOf('/');
  return cut <= 0 ? '/' : p.slice(0, cut);
}

/** Lazily detach a dead mount, as root directly, else through fusermount. */
export async function detachMount(
  mountPath: string,
  binding: NativeBinding,
): Promise<void> {
  try {
    binding.umountDetach(mountPath);
  } catch (err) {
    if (process.getuid?.() === 0) throw err;
    await run('fusermount3', ['-u', '-z', mountPath]).catch(() =>
      run('fusermount', ['-u', '-z', mountPath]),
    );
  }
}

/**
 * Mount a {@link SharedFilesystem} at a path. Everything the kernel asks
 * arrives on the event loop through the native handler and is answered from
 * the tree; a request that throws answers with the errno for its code.
 */
export async function mountSharedFilesystem(
  opts: FuseMountOptions,
): Promise<FuseMount> {
  const { binding, reason } = loadNativeBinding();
  if (!binding) throw new FuseUnavailableError(reason ?? 'no native binding');
  const mountPath = path.resolve(opts.mountPath);
  const fsName = opts.fsName ?? DEFAULT_FS_NAME;
  // Before mkdir: a stale mount answers even mkdir with ENOTCONN.
  await clearMountpoint(mountPath, {
    fsName,
    detach: (p) => detachMount(p, binding),
  });
  await mkdir(mountPath, { recursive: true });
  return new Session(binding, opts, mountPath, fsName).start();
}

interface OpenFile {
  path: string;
  handle: FsFileHandle;
}

class Session {
  private native!: NativeMount;
  private closed = false;
  private readonly inodes = new InodeTable();
  private readonly handles = new Map<number, OpenFile>();
  private nextFh = 1;
  private requests = 0;
  private errors = 0;
  private readonly fs: SharedFilesystem;
  private readonly attr: AttrOptions;
  private readonly peer: string | undefined;
  private readonly readdirBatch: number;
  private readonly logger: Logger;

  constructor(
    private readonly binding: NativeBinding,
    opts: FuseMountOptions,
    private readonly mountPath: string,
    private readonly fsName: string,
  ) {
    this.fs = opts.fs;
    this.attr = {
      uid: opts.uid ?? 0,
      gid: opts.gid ?? 0,
      blksize: DEFAULT_BLKSIZE,
      dirTtlMs: opts.dirTtlMs ?? DEFAULT_DIR_TTL_MS,
    };
    this.peer = opts.peer;
    this.readdirBatch = opts.readdirBatch ?? DEFAULT_READDIR_BATCH;
    this.logger = opts.logger ?? silentLogger;
    this.options = opts;
  }

  private readonly options: FuseMountOptions;

  start(): FuseMount {
    const opts = this.options;
    try {
      this.native = this.binding.mount(
        this.mountPath,
        {
          fsName: this.fsName,
          allowOther: opts.allowOther ?? false,
          autoUnmount: opts.autoUnmount ?? false,
          entryTtlMs: opts.entryTtlMs ?? DEFAULT_TTL_MS,
          attrTtlMs: opts.attrTtlMs ?? DEFAULT_TTL_MS,
        },
        (req) => this.handle(req),
      );
    } catch (err) {
      throw new FuseUnavailableError((err as Error).message);
    }
    this.logger.info(
      { mountPath: this.mountPath, allowOther: opts.allowOther ?? false },
      'fuse mounted',
    );
    const session = this;
    return {
      mountPath: this.mountPath,
      get mounted() {
        return !session.closed && session.native.mounted;
      },
      unmount: () => this.unmount(),
      invalidateDir: (dir) => this.invalidateDir(dir),
      invalidateEntry: (dir, name) => this.invalidateEntry(dir, name),
      stats: () => this.stats(),
    };
  }

  private stats(): FuseMountStats {
    return {
      inodes: this.inodes.size,
      openFiles: this.handles.size,
      pendingRequests: this.native.pending,
      requests: this.requests,
      errors: this.errors,
    };
  }

  private invalidateDir(dirPath: string): void {
    if (this.closed) return;
    const dir = normalizePath(dirPath);
    const ino = this.inodes.ino(dir);
    if (ino === undefined) return;
    this.native.invalInode(ino, -1, 0);
    for (const name of this.inodes.knownChildren(dir)) {
      this.native.invalEntry(ino, name);
    }
  }

  private invalidateEntry(dirPath: string, name: string): void {
    if (this.closed) return;
    const ino = this.inodes.ino(normalizePath(dirPath));
    if (ino === undefined) return;
    this.native.invalEntry(ino, name);
  }

  private async unmount(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const finished = await this.native.unmount();
    const open = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(open.map((o) => o.handle.close().catch(() => undefined)));
    this.logger.info(
      { mountPath: this.mountPath, sessionEnded: finished },
      'fuse unmounted',
    );
  }

  private handle(req: FuseRequest): void {
    this.requests++;
    this.dispatch(req).catch((err: unknown) => {
      this.errors++;
      const errno = errnoOf(err);
      if (errno === EIO) {
        this.logger.warn(
          { op: req.op, ino: String(req.ino), name: req.name, err },
          'fuse request failed',
        );
      }
      if (req.id !== 0) this.native.replyError(req.id, errno);
    });
  }

  private async node(ino: bigint): Promise<FsNode> {
    const p = this.inodes.path(ino);
    if (p === undefined) throw new FuseErrno(ENOENT, `unknown inode ${ino}`);
    const node = await this.fs.resolve(p);
    if (!node) throw new FuseErrno(ENOENT, `${p} is gone`);
    return node;
  }

  private async child(parentIno: bigint, name: string): Promise<FsNode> {
    const parent = await this.node(parentIno);
    if (parent.kind !== 'dir') throw new FuseErrno(ENOTDIR);
    const child = await this.fs.lookup(parent, name);
    if (!child) throw new FuseErrno(ENOENT, `${parent.path}/${name}`);
    return child;
  }

  private async dispatch(req: FuseRequest): Promise<void> {
    const n = this.native;
    switch (req.op) {
      case 'lookup': {
        let child: FsNode;
        try {
          child = await this.child(req.ino, req.name ?? '');
        } catch (err) {
          // A negative entry, not an errno: the kernel caches the miss for
          // the entry TTL. A scanner probing every directory for companion
          // files (nfo, posters, ...) otherwise repeats each probe forever.
          if (errnoOf(err) === ENOENT) {
            n.replyEntryNegative(req.id);
            return;
          }
          throw err;
        }
        this.inodes.remember(child.id, child.path);
        n.replyEntry(req.id, toFuseAttr(child, this.attr));
        return;
      }
      case 'forget':
        this.inodes.forget(req.ino, req.nlookup ?? 1);
        return;
      case 'getattr': {
        const node = await this.node(req.ino);
        n.replyAttr(req.id, toFuseAttr(node, this.attr));
        return;
      }
      case 'readlink': {
        const node = await this.node(req.ino);
        if (node.kind !== 'link' || node.target === undefined) {
          throw new FuseErrno(EINVAL);
        }
        n.replyData(req.id, Buffer.from(node.target));
        return;
      }
      case 'open': {
        const node = await this.node(req.ino);
        if (node.kind === 'dir') throw new FuseErrno(EISDIR);
        if (node.kind !== 'file') throw new FuseErrno(EINVAL);
        const handle = await this.fs.open(node, { peer: this.peer });
        const fh = this.nextFh++;
        this.handles.set(fh, { path: node.path, handle });
        n.replyOpen(req.id, fh, false);
        return;
      }
      case 'read': {
        const open = this.handles.get(req.fh ?? -1);
        if (!open) throw new FuseErrno(EBADF);
        const data = await open.handle.read(req.offset ?? 0, req.size ?? 0);
        n.replyData(req.id, data);
        // The reply copied the bytes out synchronously.
        releaseBuffer(data);
        return;
      }
      case 'release': {
        const fh = req.fh ?? -1;
        const open = this.handles.get(fh);
        this.handles.delete(fh);
        n.replyOk(req.id);
        if (open) {
          await open.handle
            .close()
            .catch((err: unknown) =>
              this.logger.debug(
                { err, path: open.path },
                'close after release',
              ),
            );
        }
        return;
      }
      case 'readdir':
        return this.readdir(req);
      case 'readdirplus':
        return this.readdirplus(req);
      case 'unlink':
        return this.remove(req, 'file');
      case 'rmdir':
        return this.remove(req, 'dir');
      default:
        throw new FuseErrno(ENOSYS, `unhandled op ${req.op}`);
    }
  }

  /**
   * Offsets are entry indices plus one, `.` and `..` first, so the kernel can
   * resume after any entry; a reply the kernel's buffer cuts short is
   * continued from the last offset it kept.
   */
  private async readdir(req: FuseRequest): Promise<void> {
    const dir = await this.node(req.ino);
    if (dir.kind !== 'dir') throw new FuseErrno(ENOTDIR);
    const children = await this.fs.readdir(dir);
    const start = Math.max(0, Math.floor(req.offset ?? 0));
    const total = children.length + 2;
    const out: FuseDirEntry[] = [];
    for (let i = start; i < total && out.length < this.readdirBatch; i++) {
      if (i === 0) {
        out.push({ ino: dir.id, offset: 1, kind: KIND_DIR, name: '.' });
      } else if (i === 1) {
        const parent = this.inodes.ino(parentPath(dir.path)) ?? dir.id;
        out.push({ ino: parent, offset: 2, kind: KIND_DIR, name: '..' });
      } else {
        const child = children[i - 2];
        out.push({
          ino: child.id,
          offset: i + 1,
          kind: kindOf(child),
          name: child.name,
        });
      }
    }
    this.native.replyDirectory(req.id, out);
  }

  /**
   * Same offset scheme as {@link readdir}, with attributes per entry so the
   * kernel skips the per-name lookups. The kernel takes a lookup reference
   * for every child entry its buffer keeps; the surplus is un-remembered
   * because no forget will ever come for it.
   */
  private async readdirplus(req: FuseRequest): Promise<void> {
    const dir = await this.node(req.ino);
    if (dir.kind !== 'dir') throw new FuseErrno(ENOTDIR);
    const children = await this.fs.readdir(dir);
    const start = Math.max(0, Math.floor(req.offset ?? 0));
    const total = children.length + 2;
    const out: FuseDirPlusEntry[] = [];
    const dirAttr = toFuseAttr(dir, this.attr);
    for (let i = start; i < total && out.length < this.readdirBatch; i++) {
      if (i === 0) {
        out.push({ offset: 1, name: '.', attr: dirAttr });
      } else if (i === 1) {
        // The kernel takes no reference for `.`/`..` and ignores their
        // attrs; only the ino surfaces, as d_ino in listings.
        const parent = this.inodes.ino(parentPath(dir.path)) ?? dir.id;
        out.push({ offset: 2, name: '..', attr: { ...dirAttr, ino: parent } });
      } else {
        const child = children[i - 2];
        this.inodes.remember(child.id, child.path);
        out.push({
          offset: i + 1,
          name: child.name,
          attr: toFuseAttr(child, this.attr),
        });
      }
    }
    const kept = this.native.replyDirectoryPlus(req.id, out);
    for (let i = kept; i < out.length; i++) {
      const entry = out[i];
      if (entry.name === '.' || entry.name === '..') continue;
      this.inodes.forget(entry.attr.ino, 1);
    }
  }

  private async remove(
    req: FuseRequest,
    expect: 'file' | 'dir',
  ): Promise<void> {
    const child = await this.child(req.ino, req.name ?? '');
    if (expect === 'dir' && child.kind !== 'dir') throw new FuseErrno(ENOTDIR);
    if (expect === 'file' && child.kind === 'dir') throw new FuseErrno(EISDIR);
    if (!child.removable) throw new FuseErrno(EACCES);
    const outcome = await this.fs.remove(child);
    switch (outcome) {
      case 'removed':
        this.native.replyOk(req.id);
        return;
      case 'missing':
        throw new FuseErrno(ENOENT);
      case 'denied':
        throw new FuseErrno(EACCES);
      default:
        throw new FuseErrno(EIO, `remove ${child.path}: ${outcome}`);
    }
  }
}
