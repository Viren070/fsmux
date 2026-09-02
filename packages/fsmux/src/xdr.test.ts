import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { XdrError, XdrReader, XdrWriter } from './xdr.js';

describe('XdrWriter / XdrReader', () => {
  test('integers round-trip at their extremes', () => {
    const w = new XdrWriter(4);
    w.uint32(0).uint32(1).uint32(0xffffffff);
    w.int32(-1).int32(-2147483648).int32(2147483647);
    w.uint64(0n).uint64(2n ** 64n - 1n);
    w.int64(-1n)
      .int64(-(2n ** 63n))
      .int64(2n ** 63n - 1n);
    w.bool(true).bool(false);
    assert.equal(w.length, 4 * 6 + 8 * 5 + 4 * 2);

    const r = new XdrReader(w.bytes());
    assert.deepEqual([r.uint32(), r.uint32(), r.uint32()], [0, 1, 0xffffffff]);
    assert.deepEqual(
      [r.int32(), r.int32(), r.int32()],
      [-1, -2147483648, 2147483647],
    );
    assert.deepEqual([r.uint64(), r.uint64()], [0n, 2n ** 64n - 1n]);
    assert.deepEqual(
      [r.int64(), r.int64(), r.int64()],
      [-1n, -(2n ** 63n), 2n ** 63n - 1n],
    );
    assert.deepEqual([r.bool(), r.bool()], [true, false]);
    assert.equal(r.done(), true);
  });

  test('variable opaques pad to four bytes with zeros', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 8, 9]) {
      const bytes = Buffer.alloc(length, 0xab);
      const w = new XdrWriter();
      w.opaqueVar(bytes).uint32(7);
      const padded = (length + 3) & ~3;
      assert.equal(w.length, 4 + padded + 4, `length ${length}`);
      const raw = w.bytes();
      for (let i = 4 + length; i < 4 + padded; i++) {
        assert.equal(raw[i], 0, `pad byte ${i} for length ${length}`);
      }
      const r = new XdrReader(raw);
      assert.ok(r.opaqueVar().equals(bytes));
      assert.equal(r.uint32(), 7);
    }
  });

  test('fixed opaques carry no length and still pad', () => {
    const w = new XdrWriter();
    w.opaqueFixed(Buffer.from([1, 2, 3])).uint32(9);
    assert.equal(w.length, 8);
    const r = new XdrReader(w.bytes());
    assert.deepEqual([...r.opaqueFixed(3)], [1, 2, 3]);
    assert.equal(r.uint32(), 9);
  });

  test('strings are UTF-8 with the byte length as prefix', () => {
    const text = 'héllo wörld ✓';
    const w = new XdrWriter();
    w.string(text);
    const r = new XdrReader(w.bytes());
    assert.equal(r.uint32(), Buffer.byteLength(text));
    const again = new XdrReader(w.bytes());
    assert.equal(again.string(), text);
  });

  test('truncated input throws XdrError rather than reading past the end', () => {
    assert.throws(() => new XdrReader(Buffer.alloc(3)).uint32(), XdrError);
    assert.throws(() => new XdrReader(Buffer.alloc(7)).uint64(), XdrError);
    const claimsMore = new XdrWriter().uint32(100).bytes();
    assert.throws(() => new XdrReader(claimsMore).opaqueVar(), XdrError);
    const tooLong = new XdrWriter().opaqueVar(Buffer.alloc(8)).bytes();
    assert.throws(() => new XdrReader(tooLong).opaqueVar(4), XdrError);
    assert.throws(() => new XdrReader(Buffer.alloc(2)).skip(3), XdrError);
  });

  test('the writer grows past its initial size', () => {
    const w = new XdrWriter(8);
    for (let i = 0; i < 10_000; i++) w.uint32(i);
    assert.equal(w.length, 40_000);
    const r = new XdrReader(w.bytes());
    for (let i = 0; i < 10_000; i++) assert.equal(r.uint32(), i);
  });

  test('patchUint32 and truncate rewrite what was already written', () => {
    const w = new XdrWriter();
    const countAt = w.length;
    w.uint32(0);
    w.uint32(11).uint32(22);
    const mark = w.length;
    w.uint32(33);
    w.truncate(mark);
    w.patchUint32(countAt, 2);
    const r = new XdrReader(w.bytes());
    assert.deepEqual([r.uint32(), r.uint32(), r.uint32()], [2, 11, 22]);
    assert.equal(r.done(), true);
  });

  test('a reader can be bounded to a window of a larger buffer', () => {
    const w = new XdrWriter();
    w.uint32(1).uint32(2).uint32(3);
    const r = new XdrReader(w.bytes(), 4, 8);
    assert.equal(r.uint32(), 2);
    assert.equal(r.remaining(), 0);
    assert.throws(() => r.uint32(), XdrError);
  });
});
