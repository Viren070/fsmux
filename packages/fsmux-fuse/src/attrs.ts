import type { FsNode } from '@viren070/fsmux';
import type { FuseAttr } from './native.js';

export const KIND_DIR = 0;
export const KIND_FILE = 1;
export const KIND_LINK = 2;

export interface AttrOptions {
  uid: number;
  gid: number;
  blksize: number;
  /** TTL for directory replies; files keep the mount-wide default. */
  dirTtlMs?: number;
}

export function kindOf(node: FsNode): number {
  switch (node.kind) {
    case 'dir':
      return KIND_DIR;
    case 'link':
      return KIND_LINK;
    default:
      return KIND_FILE;
  }
}

/** `modified` stands in for every timestamp; the tree keeps only one. */
export function toFuseAttr(node: FsNode, opts: AttrOptions): FuseAttr {
  return {
    ino: node.id,
    size: node.size,
    kind: kindOf(node),
    perm: node.mode & 0o7777,
    nlink: node.nlink,
    mtimeMs: node.modified.getTime(),
    uid: opts.uid,
    gid: opts.gid,
    blksize: opts.blksize,
    // Directories change rarely and have an invalidation push; caching them
    // longer keeps a scanner's metadata churn out of JavaScript.
    ttlMs: node.kind === 'dir' ? opts.dirTtlMs : undefined,
  };
}
