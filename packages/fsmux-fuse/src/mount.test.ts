// Mounts an in-memory tree through the real kernel and asserts through real
// syscalls. Everything goes through fs.promises (the libuv threadpool): a
// synchronous call would block the very event loop that has to answer it.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { MemoryFs, dir, file, type MemorySpec } from '@viren070/fsmux/testing';
import { mountSharedFilesystem, type FuseMount } from './mount.js';
import { probeFuse } from './probe.js';

const LARGE = randomBytes(24 * 1024 * 1024);
const SMALL = Buffer.from('hello from the share\n');

const tree: MemorySpec = {
  usenet: {
    'by-id': {
      abc123: {
        '0': { 'Show.S01E01.mkv': file(LARGE) },
        '1': { 'notes.txt': file(SMALL, { removable: false }) },
      },
    },
    completed: {
      tv: dir(
        {
          'Show S01E01': dir(
            {
              'Show.S01E01.mkv': {
                link: '/mnt/library/by-id/abc123/0/Show.S01E01.mkv',
                removable: true,
              },
              'stuck.mkv': file('x', {
                removable: true,
                removeOutcome: 'failed',
              }),
            },
            { removable: true },
          ),
          'kept job': dir(
            {
              'a.mkv': file('a', { removable: true, removeOutcome: 'denied' }),
            },
            { removable: true, removeOutcome: 'denied' },
          ),
        },
        { removable: false },
      ),
    },
    content: {
      'odd names': {
        'with space.txt': 'space',
        '100%.txt': 'percent',
        'ünïcödé 日本.txt': 'unicode',
        'a#b?c&d.txt': 'punct',
      },
      broken: {
        'refused.mkv': file('nope', { failOpen: 'Unavailable' }),
        'midread.mkv': file(Buffer.alloc(300_000, 7), { failReadAt: 200_000 }),
      },
    },
  },
};

const errno = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code;
  }
};

const md5 = (buf: Buffer) => createHash('md5').update(buf).digest('hex');

async function md5Stream(p: string): Promise<string> {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(p)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function readAt(p: string, offset: number, length: number) {
  const fh = await open(p, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

describe('fuse mount of a SharedFilesystem', async () => {
  const probe = await probeFuse();
  if (!probe.ok) {
    it(`skipped: ${probe.reason}`, { skip: probe.reason }, () => {});
    return;
  }

  let memory: MemoryFs;
  let mount: FuseMount;
  let root: string;
  const P = (...segments: string[]) => path.join(root, ...segments);

  before(async () => {
    memory = new MemoryFs(tree);
    root = await mkdtemp(path.join(os.tmpdir(), 'fsmux-fuse-'));
    mount = await mountSharedFilesystem({
      mountPath: root,
      fs: memory,
      fsName: 'fsmux-test',
      entryTtlMs: 500,
      attrTtlMs: 500,
      peer: 'test',
    });
  });

  after(async () => {
    await mount?.unmount();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('is mounted and lists the tree with the right types', async () => {
    assert.equal(mount.mounted, true);
    assert.deepEqual(await readdir(root), ['usenet']);
    const usenet = await readdir(P('usenet'), { withFileTypes: true });
    assert.deepEqual(
      usenet.map((e) => [e.name, e.isDirectory()]),
      [
        ['by-id', true],
        ['completed', true],
        ['content', true],
      ],
    );
    const job = await readdir(P('usenet/completed/tv/Show S01E01'), {
      withFileTypes: true,
    });
    assert.deepEqual(
      job.map((e) => [e.name, e.isSymbolicLink(), e.isFile()]),
      [
        ['Show.S01E01.mkv', true, false],
        ['stuck.mkv', false, true],
      ],
    );
  });

  it('reports stat the way the tree describes nodes', async () => {
    const d = await stat(P('usenet'));
    assert.equal(d.isDirectory(), true);
    assert.equal(d.mode & 0o777, 0o555);
    assert.equal(d.nlink, 2);
    assert.equal(d.uid, 0);
    const f = await stat(P('usenet/by-id/abc123/0/Show.S01E01.mkv'));
    assert.equal(f.isFile(), true);
    assert.equal(f.size, LARGE.length);
    assert.equal(f.mode & 0o777, 0o644);
    assert.equal(f.nlink, 1);
    assert.equal(f.mtimeMs, memory.modified.getTime());
    assert.equal(f.blksize, 128 * 1024);
    assert.equal(
      f.ino,
      Number(memory.node('/usenet/by-id/abc123/0/Show.S01E01.mkv').id),
    );
    const rootStat = await stat(root);
    assert.equal(rootStat.ino, 1);
  });

  it('serves symlinks as real symlinks with the absolute target', async () => {
    const link = P('usenet/completed/tv/Show S01E01/Show.S01E01.mkv');
    const l = await lstat(link);
    assert.equal(l.isSymbolicLink(), true);
    assert.equal(
      await readlink(link),
      '/mnt/library/by-id/abc123/0/Show.S01E01.mkv',
    );
    assert.equal(l.size, Buffer.byteLength(await readlink(link)));
  });

  it('resolves names with spaces, percent signs, punctuation and unicode', async () => {
    const names = (await readdir(P('usenet/content/odd names'))).sort();
    assert.deepEqual(
      names,
      ['100%.txt', 'a#b?c&d.txt', 'with space.txt', 'ünïcödé 日本.txt'].sort(),
    );
    assert.equal(
      await readFile(P('usenet/content/odd names/100%.txt'), 'utf8'),
      'percent',
    );
    assert.equal(
      await readFile(P('usenet/content/odd names/ünïcödé 日本.txt'), 'utf8'),
      'unicode',
    );
    assert.equal(
      await errno(stat(P('usenet/content/odd names/missing.txt'))),
      'ENOENT',
    );
  });

  it('reads whole files, at offsets and past the end exactly like the source', async () => {
    const p = P('usenet/by-id/abc123/0/Show.S01E01.mkv');
    assert.equal(
      await readFile(P('usenet/by-id/abc123/1/notes.txt'), 'utf8'),
      SMALL.toString(),
    );
    assert.equal(
      md5(await readAt(p, 0, 1 << 20)),
      md5(LARGE.subarray(0, 1 << 20)),
    );
    const mid = 7_654_321;
    assert.equal(
      md5(await readAt(p, mid, 65_536)),
      md5(LARGE.subarray(mid, mid + 65_536)),
    );
    const tail = await readAt(p, LARGE.length - 4096, 8192);
    assert.equal(tail.length, 4096);
    assert.equal(md5(tail), md5(LARGE.subarray(LARGE.length - 4096)));
    assert.equal((await readAt(p, LARGE.length + 10, 100)).length, 0);
  });

  it('streams a large file sequentially with the same digest', async () => {
    const started = Date.now();
    assert.equal(
      await md5Stream(P('usenet/by-id/abc123/0/Show.S01E01.mkv')),
      md5(LARGE),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30_000, `24 MiB took ${elapsed} ms`);
    assert.ok(memory.reads.length > 0);
    // close() returns before the kernel sends release; give it a moment.
    for (
      let i = 0;
      i < 50 && memory.closed.length < memory.opened.length;
      i++
    ) {
      await sleep(20);
    }
    assert.equal(memory.opened.length, memory.closed.length);
    assert.ok(memory.openPeers.includes('test'));
  });

  it('serves concurrent readers of the same and different files', async () => {
    const big = P('usenet/by-id/abc123/0/Show.S01E01.mkv');
    const results = await Promise.all([
      readAt(big, 0, 262_144),
      readAt(big, 10 << 20, 262_144),
      readAt(big, 20 << 20, 262_144),
      readFile(P('usenet/by-id/abc123/1/notes.txt')),
      readFile(P('usenet/content/odd names/with space.txt'), 'utf8'),
    ]);
    assert.equal(md5(results[0] as Buffer), md5(LARGE.subarray(0, 262_144)));
    assert.equal(
      md5(results[1] as Buffer),
      md5(LARGE.subarray(10 << 20, (10 << 20) + 262_144)),
    );
    assert.equal(
      md5(results[2] as Buffer),
      md5(LARGE.subarray(20 << 20, (20 << 20) + 262_144)),
    );
    assert.equal(results[4], 'space');
  });

  it('refuses writes and creation with EROFS', async () => {
    assert.equal(await errno(writeFile(P('usenet/new.txt'), 'x')), 'EROFS');
    assert.equal(await errno(mkdir(P('usenet/newdir'))), 'EROFS');
    assert.equal(
      await errno(open(P('usenet/by-id/abc123/1/notes.txt'), 'r+')),
      'EROFS',
    );
  });

  it('maps open and read failures to EIO', async () => {
    assert.equal(
      await errno(readFile(P('usenet/content/broken/refused.mkv'))),
      'EIO',
    );
    const good = await readAt(P('usenet/content/broken/midread.mkv'), 0, 4096);
    assert.equal(good.length, 4096);
    assert.equal(
      await errno(
        readAt(P('usenet/content/broken/midread.mkv'), 250_000, 4096),
      ),
      'EIO',
    );
  });

  it('maps remove outcomes to errno and unlinks what the tree lets go', async () => {
    assert.equal(
      await errno(unlink(P('usenet/by-id/abc123/1/notes.txt'))),
      'EACCES',
    );
    assert.equal(
      await errno(unlink(P('usenet/completed/tv/kept job/a.mkv'))),
      'EACCES',
    );
    assert.equal(
      await errno(rmdir(P('usenet/completed/tv/kept job'))),
      'EACCES',
    );
    assert.equal(
      await errno(unlink(P('usenet/completed/tv/Show S01E01/stuck.mkv'))),
      'EIO',
    );
    assert.equal(
      await errno(unlink(P('usenet/completed/tv/nope.mkv'))),
      'ENOENT',
    );
    assert.equal(
      await errno(rmdir(P('usenet/completed/tv/Show S01E01/stuck.mkv'))),
      'ENOTDIR',
    );
    assert.equal(
      await errno(unlink(P('usenet/completed/tv/Show S01E01'))),
      'EISDIR',
    );

    const leaf = P('usenet/completed/tv/Show S01E01/Show.S01E01.mkv');
    await unlink(leaf);
    assert.deepEqual(memory.removed, [
      '/usenet/completed/tv/Show S01E01/Show.S01E01.mkv',
    ]);
    assert.equal(await errno(lstat(leaf)), 'ENOENT');
    assert.deepEqual(await readdir(P('usenet/completed/tv/Show S01E01')), [
      'stuck.mkv',
    ]);

    await rmdir(P('usenet/completed/tv/Show S01E01'));
    assert.equal(
      await errno(stat(P('usenet/completed/tv/Show S01E01'))),
      'ENOENT',
    );
    assert.deepEqual(await readdir(P('usenet/completed/tv')), ['kept job']);
  });

  it('shows a change made behind the kernel once the directory is invalidated', async () => {
    const dirPath = P('usenet/content/odd names');
    const before = await readdir(dirPath);
    const gone = before[0];
    // Cache the name and its attributes in the kernel.
    await stat(path.join(dirPath, gone));
    // Change the tree without going through the mount.
    await memory.remove(memory.node(`/usenet/content/odd names/${gone}`));
    memory.add('/usenet/content/odd names', 'fresh.txt', 'fresh');
    memory.touch('/usenet/content/odd names', new Date());
    // The entry TTL has not expired: the kernel still believes the old name.
    assert.equal((await stat(path.join(dirPath, gone))).isFile(), true);
    mount.invalidateDir('/usenet/content/odd names');
    // Notifications are delivered from another thread; give them a moment.
    await sleep(50);
    assert.equal(await errno(stat(path.join(dirPath, gone))), 'ENOENT');
    assert.ok((await readdir(dirPath)).includes('fresh.txt'));
    assert.equal(
      await readFile(path.join(dirPath, 'fresh.txt'), 'utf8'),
      'fresh',
    );
    assert.ok((await stat(dirPath)).mtimeMs > memory.modified.getTime());
  });

  it('drops one cached name on invalidateEntry', async () => {
    const dirPath = P('usenet/content/odd names');
    await stat(path.join(dirPath, 'fresh.txt'));
    await memory.remove(memory.node('/usenet/content/odd names/fresh.txt'));
    assert.equal((await stat(path.join(dirPath, 'fresh.txt'))).isFile(), true);
    mount.invalidateEntry('/usenet/content/odd names', 'fresh.txt');
    await sleep(50);
    assert.equal(await errno(stat(path.join(dirPath, 'fresh.txt'))), 'ENOENT');
  });

  it('caches a missed lookup as a negative entry', async () => {
    const missing = P('usenet/content/odd names/never-there.nfo');
    assert.equal(await errno(stat(missing)), 'ENOENT');
    const before = mount.stats().requests;
    for (let i = 0; i < 10; i++) {
      assert.equal(await errno(stat(missing)), 'ENOENT');
    }
    // Slack for a TTL expiry mid-loop on a slow runner; without negative
    // caching every stat is its own lookup.
    const delta = mount.stats().requests - before;
    assert.ok(delta <= 2, `expected the miss cached, saw ${delta} requests`);
  });

  it('lists and stats a fresh directory without per-name lookups (readdirplus)', async () => {
    memory.add(
      '/usenet/content',
      'scan me',
      Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`ep${i}.mkv`, `bytes of ${i}`]),
      ),
    );
    memory.touch('/usenet/content', new Date());
    mount.invalidateDir('/usenet/content');
    await sleep(50);
    const dirPath = P('usenet/content/scan me');
    const names = await readdir(dirPath);
    assert.equal(names.length, 8);
    const before = mount.stats().requests;
    for (const name of names) {
      assert.ok((await stat(path.join(dirPath, name))).isFile());
    }
    const delta = mount.stats().requests - before;
    assert.ok(
      delta <= 2,
      `stats after readdirplus should be answered from cache, saw ${delta} requests`,
    );
  });

  it('keeps its bookkeeping consistent', async () => {
    const stats = mount.stats();
    assert.equal(stats.openFiles, 0);
    assert.equal(stats.pendingRequests, 0);
    assert.ok(stats.inodes > 1);
    assert.ok(stats.requests > 50);
  });

  it('unmounts cleanly and the path is an ordinary empty directory again', async () => {
    await mount.unmount();
    assert.equal(mount.mounted, false);
    await sleep(50);
    assert.deepEqual(await readdir(root), []);
    // A second unmount is a no-op.
    await mount.unmount();
  });
});
