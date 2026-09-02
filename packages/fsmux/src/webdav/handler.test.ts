import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleWebdav, parseDavPath, parseRange } from './handler.js';
import { MemoryFs, dir, file, type MemorySpec } from '../testing/memory-fs.js';

function pattern(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + (i >> 7)) & 0xff;
  return buf;
}

const BIG = pattern(200_000);

function spec(): MemorySpec {
  return {
    docs: {
      'readme.txt': 'hello world',
      'a b.txt': 'spaced',
      'big.bin': file(BIG, { etag: '"big-1"' }),
      'tom & jerry.mkv': file('x'),
      sub: { link: { link: '/mnt/target/épisode.mkv' } },
      'refused.bin': file('x', { failOpen: 'Unavailable' }),
      'private.bin': file('x', { failOpen: 'NotPermitted' }),
      'broken.bin': file(pattern(1_000_000), { failReadAt: 600_000 }),
      'dead.bin': file(pattern(1000), { failReadAt: 0 }),
    },
    '100%': { 'q.txt': 'percent' },
    jobs: {
      job1: dir(
        {
          'ep1.mkv': file('episode one', { removable: true }),
          'ep2.mkv': file('episode two', {
            removable: true,
            removeOutcome: 'denied',
          }),
          'ep3.mkv': file('episode three', {
            removable: true,
            removeOutcome: 'failed',
          }),
        },
        { removable: true },
      ),
      job2: dir(
        { 'x.mkv': file('x', { removable: true }) },
        { removable: true },
      ),
    },
  };
}

function hrefs(xml: string): string[] {
  return [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) =>
    m[1].replace(/&amp;/g, '&'),
  );
}

interface Rig {
  fs: MemoryFs;
  url: string;
  server: http.Server;
}

async function rig(withStreams: boolean): Promise<Rig> {
  const fs = new MemoryFs(spec(), { withStreams });
  const server = http.createServer((req, res) => {
    void handleWebdav(req, res, { fs, base: '/dav', peer: 'peer-1' }).catch(
      (err) => {
        res.statusCode = 500;
        res.end(String(err));
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { fs, url: `http://127.0.0.1:${port}/dav`, server };
}

async function call(
  r: Rig,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  const res = await fetch(`${r.url}${path}`, { method, headers });
  return {
    status: res.status,
    headers: res.headers,
    body: Buffer.from(await res.arrayBuffer()),
  };
}

for (const withStreams of [false, true]) {
  describe(`handleWebdav (${withStreams ? 'native streams' : 'handle reads'})`, () => {
    let r: Rig;
    before(async () => {
      r = await rig(withStreams);
    });
    after(() => r.server.close());

    test('OPTIONS advertises class 1 and the read-only method set; others are 405', async () => {
      const options = await call(r, 'OPTIONS', '/');
      assert.equal(options.status, 200);
      assert.equal(options.headers.get('dav'), '1');
      assert.match(options.headers.get('allow') ?? '', /PROPFIND/);
      for (const method of ['PUT', 'MKCOL', 'MOVE', 'PROPPATCH', 'LOCK']) {
        const res = await call(r, method, '/docs/readme.txt');
        assert.equal(res.status, 405, method);
        assert.match(res.headers.get('allow') ?? '', /GET/);
      }
    });

    test('PROPFIND depth 0 lists the node, depth 1 (the default) adds children', async () => {
      const d0 = await call(r, 'PROPFIND', '/', { Depth: '0' });
      assert.equal(d0.status, 207);
      assert.match(d0.headers.get('content-type') ?? '', /application\/xml/);
      assert.deepEqual(hrefs(d0.body.toString()), ['/dav/']);
      const d1 = await call(r, 'PROPFIND', '/');
      assert.deepEqual(hrefs(d1.body.toString()), [
        '/dav/',
        '/dav/docs/',
        '/dav/100%25/',
        '/dav/jobs/',
      ]);
      const docs = await call(r, 'PROPFIND', '/docs/', { Depth: '1' });
      const xml = docs.body.toString();
      const listed = hrefs(xml);
      assert.ok(
        listed.includes('/dav/docs/a%20b.txt'),
        'spaces are percent-encoded',
      );
      assert.ok(
        listed.includes('/dav/docs/tom%20%26%20jerry.mkv'),
        'ampersand is encoded',
      );
      assert.ok(
        listed.includes('/dav/docs/sub/'),
        'directories end with a slash',
      );
      assert.ok(!listed.some((h) => h.endsWith('/big.bin/')), 'files do not');
      assert.match(xml, /<D:displayname>tom &amp; jerry\.mkv<\/D:displayname>/);
      assert.match(xml, /<D:getcontentlength>200000<\/D:getcontentlength>/);
      assert.match(xml, /<D:getetag>&quot;big-1&quot;<\/D:getetag>/);
      assert.match(
        xml,
        /<D:getcontenttype>video\/x-matroska<\/D:getcontenttype>/,
      );
      assert.equal((xml.match(/<D:response>/g) ?? []).length, listed.length);
      assert.equal(
        (xml.match(/<D:status>HTTP\/1.1 200 OK<\/D:status>/g) ?? []).length,
        listed.length,
      );
    });

    test('a file without its own etag gets a derived one that is stable', async () => {
      const a = await call(r, 'PROPFIND', '/docs/readme.txt', { Depth: '0' });
      const b = await call(r, 'HEAD', '/docs/readme.txt');
      const fromXml = /<D:getetag>([^<]*)<\/D:getetag>/
        .exec(a.body.toString())![1]
        .replace(/&quot;/g, '"');
      assert.equal(b.headers.get('etag'), fromXml);
      assert.match(fromXml, /^"[0-9a-f]+-b-[0-9a-f]+"$/);
    });

    test('Depth: infinity is refused with the precondition', async () => {
      const res = await call(r, 'PROPFIND', '/', { Depth: 'infinity' });
      assert.equal(res.status, 403);
      assert.match(res.body.toString(), /propfind-finite-depth/);
    });

    test('links are .rclonelink text files and their bare names do not exist', async () => {
      const list = await call(r, 'PROPFIND', '/docs/sub/', { Depth: '1' });
      const xml = list.body.toString();
      assert.ok(hrefs(xml).includes('/dav/docs/sub/link.rclonelink'));
      assert.match(xml, /<D:displayname>link\.rclonelink<\/D:displayname>/);
      assert.match(
        xml,
        new RegExp(
          `<D:getcontentlength>${Buffer.byteLength('/mnt/target/épisode.mkv')}</D:getcontentlength>`,
        ),
      );
      assert.match(xml, /<D:getcontenttype>text\/plain<\/D:getcontenttype>/);

      const get = await call(r, 'GET', '/docs/sub/link.rclonelink');
      assert.equal(get.status, 200);
      assert.equal(get.body.toString(), '/mnt/target/épisode.mkv');
      assert.equal(get.headers.get('accept-ranges'), 'none');
      assert.match(get.headers.get('etag') ?? '', /^"l-[0-9a-f]{20}"$/);
      assert.equal((await call(r, 'GET', '/docs/sub/link')).status, 404);
      assert.equal(
        (await call(r, 'GET', '/docs/readme.txt.rclonelink')).status,
        404,
      );
      assert.equal(
        (await call(r, 'PROPFIND', '/docs/sub/link', { Depth: '0' })).status,
        404,
      );
    });

    test('GET and HEAD serve a whole file with validators', async () => {
      const get = await call(r, 'GET', '/docs/big.bin');
      assert.equal(get.status, 200);
      assert.ok(get.body.equals(BIG));
      assert.equal(get.headers.get('content-length'), '200000');
      assert.equal(get.headers.get('content-type'), 'application/octet-stream');
      assert.equal(get.headers.get('etag'), '"big-1"');
      assert.equal(get.headers.get('accept-ranges'), 'bytes');
      assert.equal(get.headers.get('cache-control'), 'no-store');
      const head = await call(r, 'HEAD', '/docs/big.bin');
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), '200000');
      assert.equal(head.body.length, 0);
    });

    test('single ranges, suffix ranges, open ends and the unsatisfiable ones', async () => {
      const first = await call(r, 'GET', '/docs/big.bin', {
        Range: 'bytes=0-1023',
      });
      assert.equal(first.status, 206);
      assert.equal(first.headers.get('content-range'), 'bytes 0-1023/200000');
      assert.ok(first.body.equals(BIG.subarray(0, 1024)));

      const mid = await call(r, 'GET', '/docs/big.bin', {
        Range: 'bytes=150000-150999',
      });
      assert.ok(mid.body.equals(BIG.subarray(150000, 151000)));

      const tail = await call(r, 'GET', '/docs/big.bin', {
        Range: 'bytes=-512',
      });
      assert.equal(tail.status, 206);
      assert.equal(
        tail.headers.get('content-range'),
        'bytes 199488-199999/200000',
      );
      assert.ok(tail.body.equals(BIG.subarray(199488)));

      const open = await call(r, 'GET', '/docs/big.bin', {
        Range: 'bytes=199000-',
      });
      assert.equal(open.body.length, 1000);
      assert.ok(open.body.equals(BIG.subarray(199000)));

      const past = await call(r, 'GET', '/docs/big.bin', {
        Range: 'bytes=0-999999',
      });
      assert.equal(past.status, 206);
      assert.equal(past.body.length, 200000);

      for (const bad of ['bytes=200000-', 'bytes=-0']) {
        const res = await call(r, 'GET', '/docs/big.bin', { Range: bad });
        assert.equal(res.status, 416, bad);
        assert.equal(res.headers.get('content-range'), 'bytes */200000');
      }
      for (const ignored of ['bytes=a-b', 'bytes=0-1,5-6', 'items=0-1']) {
        const res = await call(r, 'GET', '/docs/readme.txt', {
          Range: ignored,
        });
        assert.equal(res.status, 200, ignored);
        assert.equal(res.body.toString(), 'hello world');
      }
    });

    test('If-None-Match answers 304 for the current etag only', async () => {
      const hit = await call(r, 'GET', '/docs/big.bin', {
        'If-None-Match': '"big-1"',
      });
      assert.equal(hit.status, 304);
      assert.equal(hit.body.length, 0);
      const list = await call(r, 'GET', '/docs/big.bin', {
        'If-None-Match': '"nope", "big-1"',
      });
      assert.equal(list.status, 304);
      const miss = await call(r, 'GET', '/docs/big.bin', {
        'If-None-Match': '"old"',
      });
      assert.equal(miss.status, 200);
    });

    test('collections cannot be fetched and bad paths are not found', async () => {
      const onDir = await call(r, 'GET', '/docs/');
      assert.equal(onDir.status, 405);
      for (const missing of [
        '/nope',
        '/docs/nope.txt',
        '/docs/%E0%A4%A',
        '/docs/sub/link.rclonelink/x',
      ]) {
        assert.equal((await call(r, 'GET', missing)).status, 404, missing);
      }
      const percent = await call(r, 'GET', '/100%25/q.txt');
      assert.equal(percent.status, 200);
      assert.equal(percent.body.toString(), 'percent');
    });

    test('DELETE follows the filesystem outcome and refuses what is not removable', async () => {
      assert.equal((await call(r, 'DELETE', '/docs/readme.txt')).status, 403);
      assert.equal((await call(r, 'DELETE', '/jobs/job1/ep2.mkv')).status, 403);
      assert.equal((await call(r, 'DELETE', '/jobs/job1/ep3.mkv')).status, 500);
      r.fs.setDirOutcome('/jobs/job2', 'missing');
      assert.equal((await call(r, 'DELETE', '/jobs/job2/')).status, 404);
      const gone = await call(r, 'DELETE', '/jobs/job1/ep1.mkv');
      assert.equal(gone.status, 204);
      assert.deepEqual(r.fs.removed, ['/jobs/job1/ep1.mkv']);
      assert.equal((await call(r, 'GET', '/jobs/job1/ep1.mkv')).status, 404);
    });

    test('backend refusals map to HTTP statuses before any byte is sent', async () => {
      const refused = await call(r, 'GET', '/docs/refused.bin');
      assert.equal(refused.status, 503);
      assert.match(refused.body.toString(), /Unavailable/);
      assert.equal((await call(r, 'GET', '/docs/private.bin')).status, 403);
    });

    test('a failure before the first byte is a status, one mid-transfer tears the response down', async () => {
      const dead = await call(r, 'GET', '/docs/dead.bin');
      assert.equal(dead.status, 502);
      assert.match(dead.body.toString(), /failed/);

      const res = await fetch(`${r.url}/docs/broken.bin`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-length'), '1000000');
      await assert.rejects(res.arrayBuffer());
    });

    test('the peer is handed to the filesystem for attribution', async () => {
      r.fs.openPeers.length = 0;
      await call(r, 'GET', '/docs/readme.txt', { Range: 'bytes=0-4' });
      assert.deepEqual(r.fs.openPeers, ['peer-1']);
    });
  });
}

describe('handleWebdav mounted on a bare http server', () => {
  test('strips the base from the URL when no path is given', async () => {
    const fs = new MemoryFs({ 'f.txt': 'bare' });
    const server = http.createServer((req, res) => {
      void handleWebdav(req, res, { fs, base: '/share' });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/share/f.txt`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'bare');
      const root = await fetch(`http://127.0.0.1:${port}/share`, {
        method: 'PROPFIND',
        headers: { Depth: '1' },
      });
      assert.deepEqual(hrefs(await root.text()), ['/share/', '/share/f.txt']);
    } finally {
      server.close();
    }
  });
});

describe('link policy', () => {
  async function linkRig(links: 'rclonelink' | 'hide') {
    const fs = new MemoryFs(spec());
    const server = http.createServer((req, res) => {
      void handleWebdav(req, res, { fs, base: '/dav', links }).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return { fs, url: `http://127.0.0.1:${port}/dav`, server };
  }

  test('hide omits links from listings and 404s both spellings', async () => {
    const r = await linkRig('hide');
    try {
      const listing = await call(r, 'PROPFIND', '/docs/sub/', { Depth: '1' });
      assert.equal(listing.status, 207);
      assert.deepEqual(hrefs(listing.body.toString()), ['/dav/docs/sub/']);
      assert.equal((await call(r, 'GET', '/docs/sub/link')).status, 404);
      assert.equal(
        (await call(r, 'GET', '/docs/sub/link.rclonelink')).status,
        404,
      );
    } finally {
      r.server.close();
    }
  });

  test('rclonelink is the default', async () => {
    const r = await linkRig('rclonelink');
    try {
      const get = await call(r, 'GET', '/docs/sub/link.rclonelink');
      assert.equal(get.status, 200);
      assert.equal(get.body.toString(), '/mnt/target/épisode.mkv');
    } finally {
      r.server.close();
    }
  });
});

describe('range helpers', () => {
  test('parseRange accepts one range in any of the three spellings', () => {
    assert.deepEqual(parseRange('bytes=0-0'), { start: 0, endExclusive: 1 });
    assert.deepEqual(parseRange('bytes=5-'), {
      start: 5,
      endExclusive: undefined,
    });
    assert.deepEqual(parseRange('bytes=-3'), { suffixLength: 3 });
    assert.deepEqual(parseRange(' bytes=7-9 '), { start: 7, endExclusive: 10 });
    for (const bad of [
      undefined,
      '',
      'bytes=-',
      'bytes=1-2,3-4',
      'bytes=x',
      'items=0-1',
    ]) {
      assert.equal(parseRange(bad), undefined, String(bad));
    }
  });

  test('parseDavPath decodes and rejects escapes', () => {
    assert.deepEqual(parseDavPath('/a%20b//c/'), ['a b', 'c']);
    assert.deepEqual(parseDavPath('/'), []);
    for (const bad of ['/a/../b', '/a/./b', '/a%2Fb', '/a%00b', '/%E0%A4%A']) {
      assert.equal(parseDavPath(bad), undefined, bad);
    }
  });
});
