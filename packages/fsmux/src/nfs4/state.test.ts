import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FsFileHandle } from '../fs.js';
import {
  AnonymousHandles,
  ClientTable,
  OpenTable,
  isSpecialStateid,
} from './state.js';

function fakeHandle(): FsFileHandle & { closed: boolean } {
  const handle = {
    closed: false,
    read: async () => Buffer.alloc(0),
    close: async () => {
      handle.closed = true;
    },
  };
  return handle;
}

describe('ClientTable', () => {
  const id = Buffer.from('linux-client-1');
  const verifier = Buffer.from('12345678');

  test('a client is usable only after confirming with the right verifier', () => {
    const table = new ClientTable();
    const { clientId, confirm } = table.setClientId(id, verifier);
    assert.equal(table.renew(clientId), false);
    assert.equal(table.confirm(clientId, Buffer.alloc(8)), false);
    assert.equal(table.confirm(clientId + 1n, confirm), false);
    assert.equal(table.confirm(clientId, confirm), true);
    assert.equal(table.renew(clientId), true);
    assert.equal(table.has(clientId), true);
  });

  test('the same client re-registering keeps its id; a reboot replaces it', () => {
    const table = new ClientTable();
    const first = table.setClientId(id, verifier);
    table.confirm(first.clientId, first.confirm);

    const again = table.setClientId(id, verifier);
    assert.equal(again.clientId, first.clientId);
    assert.equal(again.replaced, undefined);
    assert.ok(!again.confirm.equals(first.confirm));

    const rebooted = table.setClientId(id, Buffer.from('87654321'));
    assert.notEqual(rebooted.clientId, first.clientId);
    assert.equal(rebooted.replaced, first.clientId);
    assert.equal(table.renew(first.clientId), false);
    assert.equal(table.size, 1);
  });

  test('an unconfirmed registration replaced by another is not reported as a reboot', () => {
    const table = new ClientTable();
    const first = table.setClientId(id, verifier);
    const second = table.setClientId(id, Buffer.from('other-ver'));
    assert.equal(second.replaced, undefined);
    assert.notEqual(second.clientId, first.clientId);
  });

  test('idle clients expire', () => {
    const table = new ClientTable();
    const a = table.setClientId(Buffer.from('a'), verifier, 1000);
    table.confirm(a.clientId, a.confirm, 1000);
    const b = table.setClientId(Buffer.from('b'), verifier, 5000);
    table.confirm(b.clientId, b.confirm, 5000);
    assert.deepEqual(table.expire(3000, 5500), [a.clientId]);
    assert.equal(table.has(b.clientId), true);
    assert.equal(table.has(a.clientId), false);
  });
});

describe('OpenTable', () => {
  test('stateids are found by their random part regardless of seqid', () => {
    const table = new OpenTable();
    const record = table.create(1n, '/a', fakeHandle());
    assert.equal(record.stateid.seqid, 1);
    assert.equal(record.stateid.other.length, 12);
    assert.equal(table.get({ ...record.stateid, seqid: 5 }), record);
    assert.equal(
      table.get({ seqid: 1, other: Buffer.alloc(12, 9) }),
      undefined,
    );
    assert.equal(table.remove(record.stateid), record);
    assert.equal(table.get(record.stateid), undefined);
  });

  test('removing a client returns only its opens', () => {
    const table = new OpenTable();
    const mine = table.create(1n, '/a', fakeHandle());
    const theirs = table.create(2n, '/b', fakeHandle());
    table.create(1n, '/c', fakeHandle());
    assert.deepEqual(
      table.removeClient(1n).map((r) => r.path),
      ['/a', '/c'],
    );
    assert.equal(table.get(mine.stateid), undefined);
    assert.equal(table.get(theirs.stateid), theirs);
  });
});

describe('AnonymousHandles', () => {
  test('one handle per path, evicting the least recently used', async () => {
    const handles = new AnonymousHandles(2);
    const opened: ReturnType<typeof fakeHandle>[] = [];
    const open = async () => {
      const h = fakeHandle();
      opened.push(h);
      return h;
    };
    const a = await handles.get('/a', open, 1);
    const b = await handles.get('/b', open, 2);
    assert.equal(await handles.get('/a', open, 3), a);
    await handles.get('/c', open, 4);
    assert.equal(opened.length, 3);
    assert.equal(b.closed, true);
    assert.equal(a.closed, false);
    assert.equal(handles.size, 2);
  });

  test('sweep closes handles idle past the limit', async () => {
    const handles = new AnonymousHandles();
    const a = await handles.get('/a', async () => fakeHandle(), 1000);
    const b = await handles.get('/b', async () => fakeHandle(), 4000);
    assert.equal(await handles.sweep(2000, 5000), 1);
    assert.equal((a as ReturnType<typeof fakeHandle>).closed, true);
    assert.equal((b as ReturnType<typeof fakeHandle>).closed, false);
    await handles.closeAll();
    assert.equal((b as ReturnType<typeof fakeHandle>).closed, true);
    assert.equal(handles.size, 0);
  });
});

describe('special stateids', () => {
  test('all-zero and all-one are special, anything else is not', () => {
    assert.equal(isSpecialStateid({ seqid: 0, other: Buffer.alloc(12) }), true);
    assert.equal(
      isSpecialStateid({ seqid: 0xffffffff, other: Buffer.alloc(12, 0xff) }),
      true,
    );
    assert.equal(
      isSpecialStateid({ seqid: 1, other: Buffer.alloc(12) }),
      false,
    );
    assert.equal(
      isSpecialStateid({ seqid: 0, other: Buffer.alloc(12, 0xff) }),
      false,
    );
    assert.equal(
      isSpecialStateid({ seqid: 0, other: Buffer.from('0123456789ab') }),
      false,
    );
  });
});
