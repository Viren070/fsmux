import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { XdrWriter } from '../xdr.js';
import {
  NfsServer,
  parseAllowedClients,
  type NfsServerOptions,
} from './server.js';
import { MemoryHandleStore } from './filehandle.js';
import {
  ACCESS4,
  CLAIM_PREVIOUS,
  FATTR4,
  NF4,
  NFS4_OK,
  NFS4ERR,
  OP,
  OPEN4_SHARE_ACCESS_WRITE,
} from './constants.js';
import { NfsClient, ops, type DirEntry, type Fattr } from './client.js';
import { MemoryFs, dir, file, type MemorySpec } from '../testing/memory-fs.js';
import type { Stateid } from './state.js';

function pattern(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 13 + (i >> 9)) & 0xff;
  return buf;
}

const BIG = pattern(300_000);
const LONG_NAME = 'n'.repeat(150);
const ANON: Stateid = { seqid: 0, other: Buffer.alloc(12) };

function spec(): MemorySpec {
  const many: MemorySpec = {};
  for (let i = 0; i < 200; i++)
    many[`f${String(i).padStart(3, '0')}`] = `content ${i}`;
  return {
    docs: {
      'readme.txt': 'hello world',
      'big.bin': file(BIG),
      sub: { link: { link: '/mnt/target/file.mkv' } },
      'refused.bin': file('x', { failOpen: 'Unavailable' }),
      'private.bin': file('x', { failOpen: 'NotPermitted' }),
      'broken.bin': file(pattern(1000), { failReadAt: 500 }),
    },
    jobs: {
      job1: dir(
        {
          'ep1.mkv': file('episode one', { removable: true }),
          'ep2.mkv': file('episode two', {
            removable: true,
            removeOutcome: 'denied',
          }),
        },
        { removable: true },
      ),
      job2: dir(
        { 'x.mkv': file('x', { removable: true }) },
        { removable: true },
      ),
    },
    empty: {},
    many,
    '100%': { 'a b.txt': 'spaced' },
    [LONG_NAME]: { 'deep.txt': 'deep' },
  };
}

interface Rig {
  server: NfsServer;
  fs: MemoryFs;
  port: number;
  client: NfsClient;
}

async function rig(
  overrides: Partial<NfsServerOptions> = {},
  tree = spec(),
): Promise<Rig> {
  const fs = new MemoryFs(tree);
  const server = new NfsServer({
    fs,
    port: 0,
    host: '127.0.0.1',
    maxRead: 65536,
    ...overrides,
  });
  const { port } = await server.listen();
  const client = await NfsClient.connect(port);
  return { server, fs, port, client };
}

async function stop(r: Rig): Promise<void> {
  r.client.close();
  await r.server.close();
}

function fattr(result: { value?: unknown }): Fattr {
  return result.value as Fattr;
}

describe('NfsServer', () => {
  let r: Rig;
  before(async () => {
    r = await rig();
  });
  after(async () => stop(r));

  test('NULL succeeds and an unknown procedure is refused', async () => {
    assert.equal((await r.client.null()).acceptStat, 0);
    const bad = await r.client.rpc(9, Buffer.alloc(0));
    assert.equal(bad.acceptStat, 3);
  });

  test('the root is a directory with the export-wide attributes a mount reads', async () => {
    const reply = await r.client.compound([
      ops.putrootfh(),
      ops.getfh(),
      ops.getattr([
        FATTR4.SUPPORTED_ATTRS,
        FATTR4.TYPE,
        FATTR4.FH_EXPIRE_TYPE,
        FATTR4.FILEID,
        FATTR4.MODE,
        FATTR4.NUMLINKS,
        FATTR4.LEASE_TIME,
        FATTR4.MAXREAD,
        FATTR4.MAXWRITE,
        FATTR4.ACL,
        FATTR4.MOUNTED_ON_FILEID,
      ]),
    ]);
    assert.equal(reply.status, NFS4_OK);
    assert.equal(reply.results.length, 3);
    const fh = reply.results[1].value as Buffer;
    assert.equal(fh.length, 2);
    const attrs = fattr(reply.results[2]);
    assert.equal(attrs.values.get(FATTR4.TYPE), NF4.DIR);
    assert.equal(attrs.values.get(FATTR4.FILEID), 1n);
    assert.equal(attrs.values.get(FATTR4.MODE), 0o555);
    assert.equal(attrs.values.get(FATTR4.NUMLINKS), 2);
    assert.equal(attrs.values.get(FATTR4.LEASE_TIME), 90);
    assert.equal(attrs.values.get(FATTR4.MAXREAD), 65536n);
    assert.equal(attrs.values.get(FATTR4.FH_EXPIRE_TYPE), 0);
    assert.equal(attrs.values.get(FATTR4.MOUNTED_ON_FILEID), 1n);
    assert.ok(!attrs.attrs.includes(FATTR4.ACL));
    assert.ok(
      (attrs.values.get(FATTR4.SUPPORTED_ATTRS) as number[]).includes(
        FATTR4.FILEHANDLE,
      ),
    );
  });

  test('LOOKUP walks a path and the handle it yields is reusable', async () => {
    const walk = await r.client.compound([
      ops.putrootfh(),
      ops.lookup('docs'),
      ops.lookup('readme.txt'),
      ops.getfh(),
      ops.getattr([FATTR4.TYPE, FATTR4.SIZE]),
    ]);
    assert.equal(walk.status, NFS4_OK);
    const fh = walk.results[3].value as Buffer;
    assert.equal(fattr(walk.results[4]).values.get(FATTR4.SIZE), 11n);

    const again = await r.client.compound([
      ops.putfh(fh),
      ops.getattr([FATTR4.TYPE, FATTR4.SIZE, FATTR4.FILEID]),
    ]);
    assert.equal(again.status, NFS4_OK);
    assert.equal(
      fattr(again.results[1]).values.get(FATTR4.FILEID),
      r.fs.node('/docs/readme.txt').id,
    );
  });

  test('a failing op ends the compound with the results so far', async () => {
    const reply = await r.client.compound([
      ops.putrootfh(),
      ops.lookup('docs'),
      ops.lookup('nope'),
      ops.getfh(),
    ]);
    assert.equal(reply.status, NFS4ERR.NOENT);
    assert.equal(reply.results.length, 3);
    assert.deepEqual(
      reply.results.map((x) => x.status),
      [NFS4_OK, NFS4_OK, NFS4ERR.NOENT],
    );
  });

  test('LOOKUP name validation and non-directory parents', async () => {
    const cases: [ReturnType<typeof ops.lookup>[], number][] = [
      [
        [ops.lookup('docs'), ops.lookup('readme.txt'), ops.lookup('x')],
        NFS4ERR.NOTDIR,
      ],
      [
        [
          ops.lookup('docs'),
          ops.lookup('sub'),
          ops.lookup('link'),
          ops.lookup('x'),
        ],
        NFS4ERR.SYMLINK,
      ],
      [[ops.lookup('..')], NFS4ERR.BADNAME],
      [[ops.lookup('a/b')], NFS4ERR.BADNAME],
      [[ops.lookup('')], NFS4ERR.INVAL],
    ];
    for (const [steps, status] of cases) {
      const reply = await r.client.compound([ops.putrootfh(), ...steps]);
      assert.equal(reply.status, status, steps.length.toString());
    }
    const noFh = await r.client.compound([ops.lookup('docs')]);
    assert.equal(noFh.status, NFS4ERR.NOFILEHANDLE);
  });

  test('names that are not URL-safe still resolve verbatim', async () => {
    const reply = await r.client.compound([
      ops.putrootfh(),
      ops.lookup('100%'),
      ops.lookup('a b.txt'),
      ops.getattr([FATTR4.SIZE]),
    ]);
    assert.equal(reply.status, NFS4_OK);
    assert.equal(fattr(reply.results[3]).values.get(FATTR4.SIZE), 6n);
  });

  test('LOOKUPP climbs to the parent and stops at the root', async () => {
    const up = await r.client.compound([
      ops.putrootfh(),
      ops.lookup('docs'),
      ops.lookup('sub'),
      ops.lookupp(),
      ops.getattr([FATTR4.FILEID]),
      ops.lookupp(),
      ops.getattr([FATTR4.FILEID]),
      ops.lookupp(),
    ]);
    assert.equal(up.status, NFS4ERR.NOENT);
    assert.equal(
      fattr(up.results[4]).values.get(FATTR4.FILEID),
      r.fs.node('/docs').id,
    );
    assert.equal(fattr(up.results[6]).values.get(FATTR4.FILEID), 1n);
  });

  test('SAVEFH / RESTOREFH', async () => {
    const bare = await r.client.compound([ops.putrootfh(), ops.restorefh()]);
    assert.equal(bare.status, NFS4ERR.RESTOREFH);
    const reply = await r.client.compound([
      ops.putrootfh(),
      ops.getfh(),
      ops.savefh(),
      ops.lookup('docs'),
      ops.restorefh(),
      ops.getfh(),
    ]);
    assert.equal(reply.status, NFS4_OK);
    assert.ok(
      (reply.results[1].value as Buffer).equals(
        reply.results[5].value as Buffer,
      ),
    );
  });

  test('READLINK returns the target and rejects other kinds', async () => {
    const link = await r.client.compound([
      ops.putrootfh(),
      ops.lookup('docs'),
      ops.lookup('sub'),
      ops.lookup('link'),
      ops.readlink(),
    ]);
    assert.equal(link.status, NFS4_OK);
    assert.equal(link.results[4].value, '/mnt/target/file.mkv');
    const onDir = await r.client.compound([ops.putrootfh(), ops.readlink()]);
    assert.equal(onDir.status, NFS4ERR.ISDIR);
    const onFile = await r.client.compound([
      ops.putrootfh(),
      ops.lookup('docs'),
      ops.lookup('readme.txt'),
      ops.readlink(),
    ]);
    assert.equal(onFile.status, NFS4ERR.INVAL);
  });

  describe('READDIR', () => {
    test('lists a whole directory with attributes in one reply', async () => {
      const reply = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('many'),
        ops.readdir({
          maxcount: 1 << 20,
          attrs: [FATTR4.TYPE, FATTR4.FILEID, FATTR4.SIZE],
        }),
      ]);
      assert.equal(reply.status, NFS4_OK);
      const { entries, eof } = reply.results[2].value as {
        entries: DirEntry[];
        eof: boolean;
      };
      assert.equal(eof, true);
      assert.equal(entries.length, 200);
      assert.deepEqual(
        entries.slice(0, 3).map((e) => e.name),
        ['f000', 'f001', 'f002'],
      );
      assert.deepEqual(
        entries.slice(0, 3).map((e) => e.cookie),
        [3n, 4n, 5n],
      );
      assert.equal(
        entries[7].attrs.values.get(FATTR4.SIZE),
        BigInt('content 7'.length),
      );
      assert.equal(entries[7].attrs.values.get(FATTR4.TYPE), NF4.REG);
    });

    test('pages through a directory by cookie without gaps or repeats', async () => {
      const seen: string[] = [];
      let cookie = 0n;
      let pages = 0;
      for (;;) {
        const reply = await r.client.compound([
          ops.putrootfh(),
          ops.lookup('many'),
          ops.readdir({
            cookie,
            maxcount: 400,
            attrs: [FATTR4.TYPE, FATTR4.FILEID],
          }),
        ]);
        assert.equal(reply.status, NFS4_OK);
        const { entries, eof } = reply.results[2].value as {
          entries: DirEntry[];
          eof: boolean;
        };
        pages++;
        for (const e of entries) {
          assert.ok(e.cookie > cookie, 'cookies increase');
          seen.push(e.name);
          cookie = e.cookie;
        }
        if (eof) break;
        assert.ok(entries.length > 0, 'a non-final page has entries');
      }
      assert.ok(pages > 10, `paged ${pages} times`);
      assert.equal(seen.length, 200);
      assert.equal(new Set(seen).size, 200);
    });

    test('honours dircount as a limit on names', async () => {
      const reply = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('many'),
        ops.readdir({ dircount: 40, maxcount: 1 << 20, attrs: [] }),
      ]);
      const { entries, eof } = reply.results[2].value as {
        entries: DirEntry[];
        eof: boolean;
      };
      assert.equal(entries.length, 3);
      assert.equal(eof, false);
    });

    test('TOOSMALL, BAD_COOKIE, NOTDIR and an empty directory', async () => {
      const small = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('many'),
        ops.readdir({ maxcount: 40 }),
      ]);
      assert.equal(small.status, NFS4ERR.TOOSMALL);
      const badCookie = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('many'),
        ops.readdir({ cookie: 1n }),
      ]);
      assert.equal(badCookie.status, NFS4ERR.BAD_COOKIE);
      const onFile = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('docs'),
        ops.lookup('readme.txt'),
        ops.readdir({}),
      ]);
      assert.equal(onFile.status, NFS4ERR.NOTDIR);
      const empty = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('empty'),
        ops.readdir({}),
      ]);
      assert.equal(empty.status, NFS4_OK);
      assert.deepEqual(empty.results[2].value, { entries: [], eof: true });
    });

    test('filehandles listed with readdirplus work as handles', async () => {
      const reply = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('docs'),
        ops.readdir({ attrs: [FATTR4.FILEHANDLE, FATTR4.TYPE] }),
      ]);
      const { entries } = reply.results[2].value as { entries: DirEntry[] };
      const readme = entries.find((e) => e.name === 'readme.txt')!;
      const fh = readme.attrs.values.get(FATTR4.FILEHANDLE) as Buffer;
      const direct = await r.client.compound([
        ops.putfh(fh),
        ops.getattr([FATTR4.SIZE]),
      ]);
      assert.equal(direct.status, NFS4_OK);
      assert.equal(fattr(direct.results[1]).values.get(FATTR4.SIZE), 11n);
      const link = entries.find((e) => e.name === 'sub')!;
      assert.equal(link.attrs.values.get(FATTR4.TYPE), NF4.DIR);
    });
  });

  describe('client identity', () => {
    test('confirm needs the verifier the server issued', async () => {
      const set = await r.client.compound([
        ops.setclientid(Buffer.from('c1'), randomBytes(8)),
      ]);
      const { clientId, confirm } = set.results[0].value as {
        clientId: bigint;
        confirm: Buffer;
      };
      const wrong = await r.client.compound([
        ops.setclientidConfirm(clientId, Buffer.alloc(8)),
      ]);
      assert.equal(wrong.status, NFS4ERR.STALE_CLIENTID);
      assert.equal(
        (await r.client.compound([ops.renew(clientId)])).status,
        NFS4ERR.STALE_CLIENTID,
      );
      assert.equal(
        (await r.client.compound([ops.setclientidConfirm(clientId, confirm)]))
          .status,
        NFS4_OK,
      );
      assert.equal(
        (await r.client.compound([ops.renew(clientId)])).status,
        NFS4_OK,
      );
      assert.equal(
        (await r.client.compound([ops.renew(clientId + 1n)])).status,
        NFS4ERR.STALE_CLIENTID,
      );
    });

    test('a rebooted client loses its opens', async () => {
      const id = Buffer.from('rebooter');
      const clientId = await r.client.session(id);
      const open = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('docs'),
        ops.open(clientId, 'readme.txt'),
      ]);
      const { stateid } = open.results[2].value as { stateid: Stateid };
      const before = r.fs.closed.length;
      await r.client.session(id);
      assert.equal(r.fs.closed.length, before + 1);
      const read = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('docs'),
        ops.lookup('readme.txt'),
        ops.read(stateid, 0, 5),
      ]);
      assert.equal(read.status, NFS4ERR.BAD_STATEID);
    });
  });

  describe('OPEN / READ / CLOSE', () => {
    test('reads a file through an open stateid, capped at maxread, then closes', async () => {
      const clientId = await r.client.session();
      const opened = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('docs'),
        ops.open(clientId, 'big.bin'),
        ops.getfh(),
        ops.getattr([FATTR4.SIZE]),
      ]);
      assert.equal(opened.status, NFS4_OK);
      const { stateid, rflags, delegation } = opened.results[2].value as {
        stateid: Stateid;
        rflags: number;
        delegation: number;
      };
      assert.equal(stateid.seqid, 1);
      assert.equal(delegation, 0);
      assert.equal(rflags & 2, 0, 'no OPEN_CONFIRM demanded');
      assert.equal(
        fattr(opened.results[4]).values.get(FATTR4.SIZE),
        BigInt(BIG.length),
      );
      const fh = opened.results[3].value as Buffer;
      const opensBefore = r.fs.opened.length;

      const first = await r.client.compound([
        ops.putfh(fh),
        ops.read(stateid, 0, 1 << 20),
      ]);
      const { data, eof } = first.results[1].value as {
        data: Buffer;
        eof: boolean;
      };
      assert.equal(data.length, 65536);
      assert.equal(eof, false);
      assert.ok(data.equals(BIG.subarray(0, 65536)));

      const parts: Buffer[] = [data];
      let offset = 65536;
      for (;;) {
        const reply = await r.client.compound([
          ops.putfh(fh),
          ops.read(stateid, offset, 65536),
        ]);
        const chunk = reply.results[1].value as { data: Buffer; eof: boolean };
        parts.push(chunk.data);
        offset += chunk.data.length;
        if (chunk.eof) break;
      }
      assert.ok(Buffer.concat(parts).equals(BIG));

      const seek = await r.client.compound([
        ops.putfh(fh),
        ops.read(stateid, 1234, 10),
      ]);
      assert.ok(
        (seek.results[1].value as { data: Buffer }).data.equals(
          BIG.subarray(1234, 1244),
        ),
      );
      const past = await r.client.compound([
        ops.putfh(fh),
        ops.read(stateid, BIG.length + 5, 10),
      ]);
      assert.deepEqual(past.results[1].value, {
        eof: true,
        data: Buffer.alloc(0),
      });
      assert.equal(
        r.fs.opened.length,
        opensBefore,
        'one handle serves every read',
      );

      const closed = await r.client.compound([
        ops.putfh(fh),
        ops.close(stateid),
      ]);
      assert.equal(closed.status, NFS4_OK);
      assert.equal((closed.results[1].value as Stateid).seqid, 2);
      assert.ok(r.fs.closed.includes('/docs/big.bin'));
      const after = await r.client.compound([
        ops.putfh(fh),
        ops.read(stateid, 0, 10),
      ]);
      assert.equal(after.status, NFS4ERR.BAD_STATEID);
    });

    test('a special stateid reads without an open and reuses its handle', async () => {
      const fh = await r.client.handle('/docs/readme.txt');
      const before = r.fs.opened.length;
      const a = await r.client.compound([ops.putfh(fh), ops.read(ANON, 0, 5)]);
      const b = await r.client.compound([
        ops.putfh(fh),
        ops.read(ANON, 6, 100),
      ]);
      assert.equal(
        (a.results[1].value as { data: Buffer }).data.toString(),
        'hello',
      );
      assert.deepEqual(b.results[1].value, {
        eof: true,
        data: Buffer.from('world'),
      });
      assert.equal(r.fs.opened.length, before + 1);
      const onDir = await r.client.compound([
        ops.putrootfh(),
        ops.read(ANON, 0, 5),
      ]);
      assert.equal(onDir.status, NFS4ERR.ISDIR);
    });

    test('OPEN refuses writes, creates, directories, links and unknown clients', async () => {
      const clientId = await r.client.session();
      const at = (
        name: string,
        opts: Parameters<typeof ops.open>[2] = {},
        from: string[] = ['docs'],
      ) =>
        r.client.compound([
          ops.putrootfh(),
          ...from.map((s) => ops.lookup(s)),
          ops.open(clientId, name, opts),
        ]);
      assert.equal(
        (await at('readme.txt', { access: OPEN4_SHARE_ACCESS_WRITE })).status,
        NFS4ERR.ROFS,
      );
      assert.equal(
        (await at('new.txt', { create: true })).status,
        NFS4ERR.ROFS,
      );
      assert.equal((await at('sub')).status, NFS4ERR.ISDIR);
      assert.equal(
        (await at('link', {}, ['docs', 'sub'])).status,
        NFS4ERR.SYMLINK,
      );
      assert.equal((await at('missing')).status, NFS4ERR.NOENT);
      assert.equal(
        (await at('readme.txt', { claim: CLAIM_PREVIOUS })).status,
        NFS4ERR.NOTSUPP,
      );
      const stranger = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('docs'),
        ops.open(clientId + 7n, 'readme.txt'),
      ]);
      assert.equal(stranger.status, NFS4ERR.STALE_CLIENTID);
    });

    test('backend failures surface as NFS statuses', async () => {
      const clientId = await r.client.session();
      const refused = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('docs'),
        ops.open(clientId, 'refused.bin'),
      ]);
      assert.equal(refused.status, NFS4ERR.IO);
      const forbidden = await r.client.compound([
        ops.putrootfh(),
        ops.lookup('docs'),
        ops.open(clientId, 'private.bin'),
      ]);
      assert.equal(forbidden.status, NFS4ERR.ACCESS);
      const fh = await r.client.handle('/docs/broken.bin');
      const ok = await r.client.compound([
        ops.putfh(fh),
        ops.read(ANON, 0, 100),
      ]);
      assert.equal(ok.status, NFS4_OK);
      const broken = await r.client.compound([
        ops.putfh(fh),
        ops.read(ANON, 450, 100),
      ]);
      assert.equal(broken.status, NFS4ERR.IO);
    });
  });

  test('ACCESS grants deletion only where something is removable', async () => {
    const mask =
      ACCESS4.READ |
      ACCESS4.LOOKUP |
      ACCESS4.MODIFY |
      ACCESS4.EXTEND |
      ACCESS4.DELETE |
      ACCESS4.EXECUTE;
    const on = async (...path: string[]) => {
      const reply = await r.client.compound([
        ops.putrootfh(),
        ...path.map((s) => ops.lookup(s)),
        ops.access(mask),
      ]);
      assert.equal(reply.status, NFS4_OK);
      return reply.results[reply.results.length - 1].value as {
        supported: number;
        access: number;
      };
    };
    assert.deepEqual(await on('docs', 'readme.txt'), {
      supported: mask,
      access: ACCESS4.READ,
    });
    assert.deepEqual(await on('docs'), {
      supported: mask,
      access: ACCESS4.READ | ACCESS4.LOOKUP,
    });
    assert.equal((await on('jobs')).access, mask & ~ACCESS4.EXECUTE);
    assert.equal((await on('jobs', 'job1')).access, mask & ~ACCESS4.EXECUTE);
    const readOnlyAsk = await r.client.compound([
      ops.putrootfh(),
      ops.lookup('jobs'),
      ops.access(ACCESS4.READ),
    ]);
    assert.deepEqual(readOnlyAsk.results[2].value, {
      supported: ACCESS4.READ,
      access: ACCESS4.READ,
    });
  });

  test("REMOVE follows the filesystem's outcome", async () => {
    const remove = (dirPath: string[], name: string) =>
      r.client.compound([
        ops.putrootfh(),
        ...dirPath.map((s) => ops.lookup(s)),
        ops.remove(name),
      ]);
    assert.equal(
      (await remove(['jobs', 'job1'], 'ep2.mkv')).status,
      NFS4ERR.ACCESS,
    );
    assert.equal((await remove(['docs'], 'readme.txt')).status, NFS4ERR.ACCESS);
    assert.equal(
      (await remove(['jobs', 'job1'], 'ghost.mkv')).status,
      NFS4ERR.NOENT,
    );
    r.fs.setDirOutcome('/jobs/job2', 'missing');
    assert.equal((await remove(['jobs'], 'job2')).status, NFS4ERR.NOENT);
    const removed = await remove(['jobs', 'job1'], 'ep1.mkv');
    assert.equal(removed.status, NFS4_OK);
    assert.deepEqual(r.fs.removed, ['/jobs/job1/ep1.mkv']);
    assert.equal(
      (await remove(['jobs', 'job1'], 'ep1.mkv')).status,
      NFS4ERR.NOENT,
    );
  });

  test('SECINFO offers AUTH_SYS then AUTH_NONE for a name that exists', async () => {
    const reply = await r.client.compound([
      ops.putrootfh(),
      ops.secinfo('docs'),
    ]);
    assert.equal(reply.status, NFS4_OK);
    assert.deepEqual(reply.results[1].value, [1, 0]);
    assert.equal(
      (await r.client.compound([ops.putrootfh(), ops.secinfo('nope')])).status,
      NFS4ERR.NOENT,
    );
  });

  test('VERIFY / NVERIFY compare encoded attributes', async () => {
    const eleven = new XdrWriter().uint64(11n).bytes();
    const twelve = new XdrWriter().uint64(12n).bytes();
    const at = (spec: ReturnType<typeof ops.verify>) =>
      r.client.compound([
        ops.putrootfh(),
        ops.lookup('docs'),
        ops.lookup('readme.txt'),
        spec,
      ]);
    assert.equal((await at(ops.verify([FATTR4.SIZE], eleven))).status, NFS4_OK);
    assert.equal(
      (await at(ops.verify([FATTR4.SIZE], twelve))).status,
      NFS4ERR.NOT_SAME,
    );
    assert.equal(
      (await at(ops.nverify([FATTR4.SIZE], eleven))).status,
      NFS4ERR.SAME,
    );
    assert.equal(
      (await at(ops.nverify([FATTR4.SIZE], twelve))).status,
      NFS4_OK,
    );
    assert.equal(
      (await at(ops.verify([FATTR4.ACL], Buffer.alloc(0)))).status,
      NFS4ERR.ATTRNOTSUPP,
    );
  });

  test('minor version 1 is refused before any op runs', async () => {
    const reply = await r.client.compound([ops.putrootfh(), ops.getfh()], {
      minor: 1,
      tag: 'v41',
    });
    assert.equal(reply.status, NFS4ERR.MINOR_VERS_MISMATCH);
    assert.equal(reply.tag, 'v41');
    assert.equal(reply.results.length, 0);
  });

  test('an unknown op is reported as ILLEGAL after the results before it', async () => {
    const reply = await r.client.compound([
      ops.putrootfh(),
      ops.raw(9999),
      ops.getfh(),
    ]);
    assert.equal(reply.status, NFS4ERR.OP_ILLEGAL);
    assert.equal(reply.results.length, 2);
    assert.equal(reply.results[1].op, OP.ILLEGAL);
    const locks = await r.client.compound([ops.putrootfh(), ops.raw(OP.LOCK)]);
    assert.equal(locks.status, NFS4ERR.LOCK_NOTSUPP);
    const write = await r.client.compound([ops.putrootfh(), ops.raw(OP.WRITE)]);
    assert.equal(write.status, NFS4ERR.ROFS);
  });

  test('compounds pipelined on one connection each get their own answer', async () => {
    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        r.client.compound(
          [
            ops.putrootfh(),
            ops.lookup('many'),
            ops.lookup(`f${String(i).padStart(3, '0')}`),
            ops.getattr([FATTR4.SIZE]),
          ],
          {
            tag: `t${i}`,
          },
        ),
      ),
    );
    replies.forEach((reply, i) => {
      assert.equal(reply.tag, `t${i}`);
      assert.equal(
        fattr(reply.results[3]).values.get(FATTR4.SIZE),
        BigInt(`content ${i}`.length),
      );
    });
  });
});

describe('filehandle persistence', () => {
  test('a hashed handle survives a restart with the same store and is stale without it', async () => {
    const store = new MemoryHandleStore();
    const first = await rig({ handleStore: store });
    const fh = await first.client.handle(`/${LONG_NAME}/deep.txt`);
    assert.equal(fh.length, 9);
    await stop(first);

    const second = await rig({ handleStore: store });
    const ok = await second.client.compound([
      ops.putfh(fh),
      ops.getattr([FATTR4.SIZE]),
    ]);
    assert.equal(ok.status, NFS4_OK);
    assert.equal(fattr(ok.results[1]).values.get(FATTR4.SIZE), 4n);
    await stop(second);

    const third = await rig();
    const stale = await third.client.compound([
      ops.putfh(fh),
      ops.getattr([FATTR4.SIZE]),
    ]);
    assert.equal(stale.status, NFS4ERR.STALE);
    const garbage = await third.client.compound([
      ops.putfh(Buffer.from([9, 9])),
    ]);
    assert.equal(garbage.status, NFS4ERR.BADHANDLE);
    await stop(third);
  });

  test('a short handle of a node that disappeared is stale', async () => {
    const r2 = await rig();
    const fh = await r2.client.handle('/jobs/job1/ep1.mkv');
    await r2.client.compound([
      ops.putrootfh(),
      ops.lookup('jobs'),
      ops.lookup('job1'),
      ops.remove('ep1.mkv'),
    ]);
    const reply = await r2.client.compound([ops.putfh(fh)]);
    assert.equal(reply.status, NFS4ERR.STALE);
    await stop(r2);
  });
});

describe('allowed clients', () => {
  test('a peer outside the list is dropped, one inside is served', async () => {
    const closed = await rig({ allowedClients: ['10.0.0.0/8'] });
    assert.equal(await closed.client.closedByPeer(), true);
    await closed.server.close();

    const served = await rig({ allowedClients: ['10.0.0.0/8', '127.0.0.1'] });
    assert.equal((await served.client.null()).acceptStat, 0);
    await stop(served);
  });

  test('parseAllowedClients accepts addresses and blocks of both families', () => {
    const list = parseAllowedClients([
      '192.168.1.0/24',
      ' ::1 ',
      'fc00::/7',
      '',
      '10.1.2.3',
    ]);
    assert.equal(list.check('192.168.1.77'), true);
    assert.equal(list.check('192.168.2.1'), false);
    assert.equal(list.check('::1', 'ipv6'), true);
    assert.equal(list.check('fd12::1', 'ipv6'), true);
    assert.equal(list.check('10.1.2.3'), true);
    assert.equal(list.check('10.1.2.4'), false);
    assert.throws(() => parseAllowedClients(['not-an-ip']), /not an IP/);
  });
});
