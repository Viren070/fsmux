import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { XdrReader, XdrWriter } from '../xdr.js';
import type { FsNode } from '../fs.js';
import {
  SUPPORTED_ATTRS,
  encodeAttrValues,
  readBitmap,
  supportedOf,
  writeBitmap,
  writeFattr4,
  type FsInfo,
} from './attrs.js';
import { FATTR4, NF4 } from './constants.js';
import { decodeFattr } from './client.js';

const info: FsInfo = {
  leaseTime: 90,
  maxRead: 65536,
  maxWrite: 65536,
  uid: 1000,
  gid: 1001,
};

const file: FsNode = {
  kind: 'file',
  path: '/docs/a.mkv',
  name: 'a.mkv',
  id: 0x1122334455667788n,
  mode: 0o100444,
  nlink: 1,
  size: 5_000_000_000,
  modified: new Date('2024-06-01T12:00:00.250Z'),
};

describe('bitmaps', () => {
  test('round-trip across word boundaries', () => {
    for (const attrs of [[], [0], [31], [32], [3, 33, 55], [0, 64]]) {
      const w = new XdrWriter();
      writeBitmap(w, attrs);
      const r = new XdrReader(w.bytes());
      assert.deepEqual(readBitmap(r), attrs, JSON.stringify(attrs));
      assert.equal(r.done(), true);
    }
  });

  test("the word count is the highest attribute's word", () => {
    const w = new XdrWriter();
    writeBitmap(w, [1, 55]);
    const r = new XdrReader(w.bytes());
    assert.equal(r.uint32(), 2);
    assert.equal(r.uint32(), 1 << 1);
    assert.equal(r.uint32(), 1 << (55 - 32));
  });

  test('supportedOf drops what we cannot answer and sorts the rest', () => {
    assert.deepEqual(
      supportedOf([
        FATTR4.MODE,
        FATTR4.ACL,
        FATTR4.TYPE,
        FATTR4.MIMETYPE,
        FATTR4.TIME_ACCESS_SET,
        FATTR4.SIZE,
      ]),
      [FATTR4.TYPE, FATTR4.SIZE, FATTR4.MODE],
    );
    assert.ok(!SUPPORTED_ATTRS.includes(FATTR4.ACL));
    assert.ok(SUPPORTED_ATTRS.includes(FATTR4.FILEHANDLE));
    assert.ok(SUPPORTED_ATTRS.includes(FATTR4.MOUNTED_ON_FILEID));
  });
});

describe('attribute values', () => {
  test('are laid out in attribute order with their XDR shapes', () => {
    const values = encodeAttrValues(
      [FATTR4.TYPE, FATTR4.SIZE, FATTR4.FILEID],
      { node: file, fh: Buffer.alloc(0) },
      info,
    );
    const expected = new XdrWriter()
      .uint32(NF4.REG)
      .uint64(5_000_000_000n)
      .uint64(0x1122334455667788n)
      .bytes();
    assert.ok(values.equals(expected));
  });

  test('a fattr4 answers only the supported part of a request', () => {
    const w = new XdrWriter();
    writeFattr4(
      w,
      [
        FATTR4.ACL,
        FATTR4.MODE,
        FATTR4.OWNER,
        FATTR4.OWNER_GROUP,
        FATTR4.TIME_MODIFY,
        FATTR4.CHANGE,
        FATTR4.MAXREAD,
        FATTR4.SUPPORTED_ATTRS,
        FATTR4.FILEHANDLE,
      ],
      { node: file, fh: Buffer.from('fh!') },
      info,
    );
    const r = new XdrReader(w.bytes());
    const fattr = decodeFattr(r);
    assert.equal(r.done(), true);
    assert.deepEqual(fattr.attrs, [
      FATTR4.SUPPORTED_ATTRS,
      FATTR4.CHANGE,
      FATTR4.FILEHANDLE,
      FATTR4.MAXREAD,
      FATTR4.MODE,
      FATTR4.OWNER,
      FATTR4.OWNER_GROUP,
      FATTR4.TIME_MODIFY,
    ]);
    assert.equal(fattr.values.get(FATTR4.MODE), 0o444);
    assert.equal(fattr.values.get(FATTR4.OWNER), '1000');
    assert.equal(fattr.values.get(FATTR4.OWNER_GROUP), '1001');
    assert.deepEqual(fattr.values.get(FATTR4.TIME_MODIFY), {
      seconds: BigInt(Math.floor(file.modified.getTime() / 1000)),
      nseconds: 250_000_000,
    });
    assert.equal(
      fattr.values.get(FATTR4.CHANGE),
      BigInt(file.modified.getTime()),
    );
    assert.equal(fattr.values.get(FATTR4.MAXREAD), 65536n);
    assert.ok(
      (fattr.values.get(FATTR4.FILEHANDLE) as Buffer).equals(
        Buffer.from('fh!'),
      ),
    );
    assert.deepEqual(fattr.values.get(FATTR4.SUPPORTED_ATTRS), SUPPORTED_ATTRS);
  });

  test('directories and links report their own type and mode bits', () => {
    const dir: FsNode = {
      ...file,
      kind: 'dir',
      mode: 0o040555,
      nlink: 2,
      size: 0,
    };
    const link: FsNode = {
      ...file,
      kind: 'link',
      mode: 0o120777,
      target: '/t',
      size: 2,
    };
    for (const [node, type, mode] of [
      [dir, NF4.DIR, 0o555],
      [link, NF4.LNK, 0o777],
    ] as const) {
      const w = new XdrWriter();
      writeFattr4(
        w,
        [FATTR4.TYPE, FATTR4.MODE],
        { node, fh: Buffer.alloc(0) },
        info,
      );
      const fattr = decodeFattr(new XdrReader(w.bytes()));
      assert.equal(fattr.values.get(FATTR4.TYPE), type);
      assert.equal(fattr.values.get(FATTR4.MODE), mode);
    }
  });
});
