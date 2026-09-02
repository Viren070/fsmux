import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InodeTable, ROOT_INO } from './inodes.js';

describe('InodeTable', () => {
  it('starts with the root and never forgets it', () => {
    const t = new InodeTable();
    assert.equal(t.path(ROOT_INO), '/');
    assert.equal(t.ino('/'), ROOT_INO);
    t.forget(ROOT_INO, 100);
    assert.equal(t.path(ROOT_INO), '/');
    assert.equal(t.size, 1);
  });

  it('counts lookups and drops an inode once every reference is forgotten', () => {
    const t = new InodeTable();
    t.remember(42n, '/a/b');
    t.remember(42n, '/a/b');
    t.remember(42n, '/a/b');
    assert.equal(t.path(42n), '/a/b');
    t.forget(42n, 2);
    assert.equal(t.path(42n), '/a/b');
    t.forget(42n, 1);
    assert.equal(t.path(42n), undefined);
    assert.equal(t.ino('/a/b'), undefined);
  });

  it('indexes remembered names by parent for invalidation', () => {
    const t = new InodeTable();
    t.remember(2n, '/usenet');
    t.remember(3n, '/usenet/completed');
    t.remember(4n, '/usenet/completed/job one');
    t.remember(5n, '/usenet/completed/job two');
    assert.deepEqual(t.knownChildren('/usenet/completed').sort(), [
      'job one',
      'job two',
    ]);
    assert.deepEqual(t.knownChildren('/'), ['usenet']);
    t.forget(4n, 1);
    assert.deepEqual(t.knownChildren('/usenet/completed'), ['job two']);
    t.forget(5n, 1);
    assert.deepEqual(t.knownChildren('/usenet/completed'), []);
  });

  it('ignores forgets for inodes it never handed out', () => {
    const t = new InodeTable();
    t.forget(999n, 1);
    assert.equal(t.size, 1);
  });
});
