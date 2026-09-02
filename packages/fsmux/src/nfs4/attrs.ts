import type { FsNode } from '../fs.js';
import { XdrReader, XdrWriter } from '../xdr.js';
import { FATTR4, FH4_PERSISTENT, NF4, NFS4_OK } from './constants.js';

/** Export-wide values an attribute may need. */
export interface FsInfo {
  leaseTime: number;
  maxRead: number;
  maxWrite: number;
  /** Reported as numeric owner strings; nothing is ever chowned. */
  uid: number;
  gid: number;
}

export interface AttrSubject {
  node: FsNode;
  fh: Buffer;
}

/** Any stable value; clients compare it to detect a filesystem boundary. */
const FSID_MAJOR = 0x41494f53n;
const SPACE_TOTAL = 1n << 50n;
const FILES_TOTAL = 1n << 32n;
const MAX_NAME = 255;

export function readBitmap(r: XdrReader): number[] {
  const words = r.uint32();
  const attrs: number[] = [];
  for (let i = 0; i < words; i++) {
    const word = r.uint32();
    for (let bit = 0; bit < 32; bit++) {
      if (word & (1 << bit)) attrs.push(i * 32 + bit);
    }
  }
  return attrs;
}

export function writeBitmap(w: XdrWriter, attrs: Iterable<number>): void {
  const words: number[] = [];
  for (const attr of attrs) {
    const index = attr >>> 5;
    while (words.length <= index) words.push(0);
    words[index] = (words[index] | (1 << (attr & 31))) >>> 0;
  }
  w.uint32(words.length);
  for (const word of words) w.uint32(word);
}

function nfstime(w: XdrWriter, date: Date): void {
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1000);
  w.int64(BigInt(seconds)).uint32((ms - seconds * 1000) * 1_000_000);
}

function ftype(node: FsNode): number {
  switch (node.kind) {
    case 'dir':
      return NF4.DIR;
    case 'file':
      return NF4.REG;
    case 'link':
      return NF4.LNK;
  }
}

type Encoder = (w: XdrWriter, s: AttrSubject, info: FsInfo) => void;

const ENCODERS = new Map<number, Encoder>([
  [FATTR4.SUPPORTED_ATTRS, (w) => writeBitmap(w, SUPPORTED_ATTRS)],
  [FATTR4.TYPE, (w, s) => w.uint32(ftype(s.node))],
  [FATTR4.FH_EXPIRE_TYPE, (w) => w.uint32(FH4_PERSISTENT)],
  [FATTR4.CHANGE, (w, s) => w.uint64(BigInt(s.node.modified.getTime()))],
  [FATTR4.SIZE, (w, s) => w.uint64(BigInt(s.node.size))],
  [FATTR4.LINK_SUPPORT, (w) => w.bool(false)],
  [FATTR4.SYMLINK_SUPPORT, (w) => w.bool(true)],
  [FATTR4.NAMED_ATTR, (w) => w.bool(false)],
  [FATTR4.FSID, (w) => w.uint64(FSID_MAJOR).uint64(0n)],
  [FATTR4.UNIQUE_HANDLES, (w) => w.bool(true)],
  [FATTR4.LEASE_TIME, (w, _s, info) => w.uint32(info.leaseTime)],
  [FATTR4.RDATTR_ERROR, (w) => w.uint32(NFS4_OK)],
  [FATTR4.ACLSUPPORT, (w) => w.uint32(0)],
  [FATTR4.ARCHIVE, (w) => w.bool(false)],
  [FATTR4.CANSETTIME, (w) => w.bool(false)],
  [FATTR4.CASE_INSENSITIVE, (w) => w.bool(false)],
  [FATTR4.CASE_PRESERVING, (w) => w.bool(true)],
  [FATTR4.CHOWN_RESTRICTED, (w) => w.bool(true)],
  [FATTR4.FILEHANDLE, (w, s) => w.opaqueVar(s.fh)],
  [FATTR4.FILEID, (w, s) => w.uint64(s.node.id)],
  [FATTR4.FILES_AVAIL, (w) => w.uint64(FILES_TOTAL)],
  [FATTR4.FILES_FREE, (w) => w.uint64(FILES_TOTAL)],
  [FATTR4.FILES_TOTAL, (w) => w.uint64(FILES_TOTAL)],
  [FATTR4.HIDDEN, (w) => w.bool(false)],
  [FATTR4.HOMOGENEOUS, (w) => w.bool(true)],
  [FATTR4.MAXFILESIZE, (w) => w.uint64(0x7fffffffffffffffn)],
  [FATTR4.MAXLINK, (w) => w.uint32(1)],
  [FATTR4.MAXNAME, (w) => w.uint32(MAX_NAME)],
  [FATTR4.MAXREAD, (w, _s, info) => w.uint64(BigInt(info.maxRead))],
  [FATTR4.MAXWRITE, (w, _s, info) => w.uint64(BigInt(info.maxWrite))],
  [FATTR4.MODE, (w, s) => w.uint32(s.node.mode & 0o7777)],
  [FATTR4.NO_TRUNC, (w) => w.bool(true)],
  [FATTR4.NUMLINKS, (w, s) => w.uint32(s.node.nlink)],
  [FATTR4.OWNER, (w, _s, info) => w.string(String(info.uid))],
  [FATTR4.OWNER_GROUP, (w, _s, info) => w.string(String(info.gid))],
  [FATTR4.RAWDEV, (w) => w.uint32(0).uint32(0)],
  [FATTR4.SPACE_AVAIL, (w) => w.uint64(SPACE_TOTAL)],
  [FATTR4.SPACE_FREE, (w) => w.uint64(SPACE_TOTAL)],
  [FATTR4.SPACE_TOTAL, (w) => w.uint64(SPACE_TOTAL)],
  [FATTR4.SPACE_USED, (w, s) => w.uint64(BigInt(s.node.size))],
  [FATTR4.SYSTEM, (w) => w.bool(false)],
  [FATTR4.TIME_ACCESS, (w, s) => nfstime(w, s.node.modified)],
  [FATTR4.TIME_CREATE, (w, s) => nfstime(w, s.node.modified)],
  [FATTR4.TIME_DELTA, (w) => w.int64(0n).uint32(1_000_000)],
  [FATTR4.TIME_METADATA, (w, s) => nfstime(w, s.node.modified)],
  [FATTR4.TIME_MODIFY, (w, s) => nfstime(w, s.node.modified)],
  [FATTR4.MOUNTED_ON_FILEID, (w, s) => w.uint64(s.node.id)],
]);

export const SUPPORTED_ATTRS: readonly number[] = [...ENCODERS.keys()].sort(
  (a, b) => a - b,
);

/** The attribute values for a bitmap, without the bitmap itself. */
export function encodeAttrValues(
  attrs: number[],
  subject: AttrSubject,
  info: FsInfo,
): Buffer {
  const w = new XdrWriter(128);
  for (const attr of attrs) ENCODERS.get(attr)!(w, subject, info);
  return w.bytes();
}

export function supportedOf(requested: number[]): number[] {
  return requested.filter((attr) => ENCODERS.has(attr)).sort((a, b) => a - b);
}

/**
 * A `fattr4`: the bitmap of what was requested and is supported, then the
 * values in attribute order. Unsupported attributes are silently left out,
 * as the protocol allows.
 */
export function writeFattr4(
  w: XdrWriter,
  requested: number[],
  subject: AttrSubject,
  info: FsInfo,
): void {
  const attrs = supportedOf(requested);
  writeBitmap(w, attrs);
  w.opaqueVar(encodeAttrValues(attrs, subject, info));
}
