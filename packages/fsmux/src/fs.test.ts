import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRange } from './fs.js';

describe('fs', () => {
  test('resolveRange clamps to the file', () => {
    assert.deepEqual(resolveRange(undefined, 10), { start: 0, end: 10 });
    assert.deepEqual(resolveRange({ start: 2, endExclusive: 5 }, 10), {
      start: 2,
      end: 5,
    });
    assert.deepEqual(resolveRange({ start: 2, endExclusive: 50 }, 10), {
      start: 2,
      end: 10,
    });
    assert.deepEqual(resolveRange({ start: 2 }, 10), { start: 2, end: 10 });
    assert.deepEqual(resolveRange({ suffixLength: 3 }, 10), {
      start: 7,
      end: 10,
    });
    assert.deepEqual(resolveRange({ suffixLength: 30 }, 10), {
      start: 0,
      end: 10,
    });
    assert.deepEqual(resolveRange({ start: 12 }, 10), { start: 12, end: 12 });
  });
});
