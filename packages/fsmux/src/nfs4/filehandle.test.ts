import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BadHandleError,
  FileHandles,
  JsonFileHandleStore,
  MemoryHandleStore,
  pathHandleId,
} from './filehandle.js';

describe('FileHandles', () => {
  test('a path up to 127 bytes is the handle itself', () => {
    const handles = new FileHandles();
    const exact = '/' + 'a'.repeat(126);
    const fh = handles.encode(exact);
    assert.equal(fh.length, 128);
    assert.equal(fh[0], 0);
    assert.equal(handles.decode(fh), exact);
    assert.equal(handles.decode(handles.encode('/')), '/');
  });

  test('a longer path becomes a 9-byte hash the store can reverse', () => {
    const store = new MemoryHandleStore();
    const handles = new FileHandles(store);
    const long = '/' + 'b'.repeat(127);
    const fh = handles.encode(long);
    assert.equal(fh.length, 9);
    assert.equal(fh[0], 1);
    assert.equal(fh.readBigUInt64BE(1), pathHandleId(long));
    assert.equal(handles.decode(fh), long);
    assert.equal(store.size, 1);
    handles.encode(long);
    assert.equal(store.size, 1);
  });

  test('byte length decides, not character count', () => {
    const handles = new FileHandles();
    const accented = '/' + 'é'.repeat(70);
    assert.equal(accented.length, 71);
    assert.equal(handles.encode(accented).length, 9);
    const short = '/' + 'é'.repeat(60);
    const fh = handles.encode(short);
    assert.equal(fh[0], 0);
    assert.equal(handles.decode(fh), short);
  });

  test('a hash nobody stored is stale, a malformed handle is bad', () => {
    const handles = new FileHandles(new MemoryHandleStore());
    const unknown = Buffer.alloc(9);
    unknown[0] = 1;
    unknown.writeBigUInt64BE(12345n, 1);
    assert.equal(handles.decode(unknown), undefined);
    for (const bad of [
      Buffer.alloc(0),
      Buffer.alloc(129),
      Buffer.from([7, 1, 2]),
      Buffer.from([1, 1, 2, 3]),
      Buffer.from([0, ...Buffer.from('relative')]),
      Buffer.from([0, ...Buffer.from('/trailing/')]),
    ]) {
      assert.throws(
        () => handles.decode(bad),
        BadHandleError,
        bad.toString('hex'),
      );
    }
  });

  test('the memory store forgets its oldest entries past the cap', () => {
    const store = new MemoryHandleStore(2);
    const handles = new FileHandles(store);
    const paths = ['x', 'y', 'z'].map((c) => '/' + c.repeat(130));
    const fhs = paths.map((p) => handles.encode(p));
    assert.equal(handles.decode(fhs[0]), undefined);
    assert.equal(handles.decode(fhs[1]), paths[1]);
    assert.equal(handles.decode(fhs[2]), paths[2]);
  });

  test('the JSON store survives a new process', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'fh-'));
    const file = path.join(dir, 'nested', 'handles.json');
    try {
      const first = new JsonFileHandleStore(file, { flushDelayMs: 5 });
      assert.equal(await first.load(), 0);
      const handles = new FileHandles(first);
      const paths = ['/' + 'p'.repeat(200), '/' + 'q'.repeat(300) + '/é'];
      const fhs = paths.map((p) => handles.encode(p));
      await first.close();

      const written = JSON.parse(await readFile(file, 'utf8')) as Record<
        string,
        string
      >;
      assert.deepEqual(Object.values(written).sort(), [...paths].sort());
      for (const key of Object.keys(written)) assert.match(key, /^[0-9a-f]+$/);

      const second = new JsonFileHandleStore(file);
      assert.equal(await second.load(), 2);
      const reopened = new FileHandles(second);
      assert.equal(reopened.decode(fhs[0]), paths[0]);
      assert.equal(reopened.decode(fhs[1]), paths[1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
