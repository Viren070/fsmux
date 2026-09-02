import { describe, test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCEPT_GARBAGE_ARGS,
  ACCEPT_PROC_UNAVAIL,
  ACCEPT_PROG_MISMATCH,
  ACCEPT_PROG_UNAVAIL,
  ACCEPT_SUCCESS,
  ACCEPT_SYSTEM_ERR,
  AUTH_NONE,
  AUTH_STAT_TOOWEAK,
  AUTH_SYS,
  MSG_CALL,
  MSG_REPLY,
  REJECT_AUTH_ERROR,
  REJECT_RPC_MISMATCH,
  REPLY_ACCEPTED,
  REPLY_DENIED,
  RPCSEC_GSS,
  RecordReader,
  RpcError,
  RpcServer,
  encodeAccepted,
  frameRecord,
  parseCall,
} from './rpc.js';
import { XdrError, XdrReader, XdrWriter } from './xdr.js';
import { NfsClient } from './nfs4/client.js';

function callRecord(opts: {
  xid?: number;
  rpcVersion?: number;
  prog?: number;
  vers?: number;
  proc?: number;
  flavor?: number;
  cred?: Buffer;
  args?: Buffer;
  msgType?: number;
}): Buffer {
  const w = new XdrWriter();
  w.uint32(opts.xid ?? 7)
    .uint32(opts.msgType ?? MSG_CALL)
    .uint32(opts.rpcVersion ?? 2)
    .uint32(opts.prog ?? 100003)
    .uint32(opts.vers ?? 4)
    .uint32(opts.proc ?? 1)
    .uint32(opts.flavor ?? AUTH_NONE)
    .opaqueVar(opts.cred ?? Buffer.alloc(0))
    .uint32(AUTH_NONE)
    .opaqueVar(Buffer.alloc(0));
  if (opts.args) w.raw(opts.args);
  return w.toBuffer();
}

function fragment(payload: Buffer, last: boolean): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE((payload.length | (last ? 0x80000000 : 0)) >>> 0, 0);
  return Buffer.concat([header, payload]);
}

describe('RecordReader', () => {
  test('reassembles a record fed one byte at a time', () => {
    const records: Buffer[] = [];
    const reader = new RecordReader(1024, (r) => records.push(r));
    const payload = Buffer.from('hello record');
    const wire = frameRecord(payload);
    for (const byte of wire) reader.push(Buffer.from([byte]));
    assert.equal(records.length, 1);
    assert.ok(records[0].equals(payload));
  });

  test('splits several records arriving in one chunk', () => {
    const records: Buffer[] = [];
    const reader = new RecordReader(1024, (r) => records.push(r));
    reader.push(
      Buffer.concat([
        frameRecord(Buffer.from('a')),
        frameRecord(Buffer.from('bb')),
        frameRecord(Buffer.alloc(0)),
      ]),
    );
    assert.deepEqual(
      records.map((r) => r.toString()),
      ['a', 'bb', ''],
    );
  });

  test('joins fragments of one record in order', () => {
    const records: Buffer[] = [];
    const reader = new RecordReader(1024, (r) => records.push(r));
    reader.push(fragment(Buffer.from('one-'), false));
    assert.equal(records.length, 0);
    reader.push(fragment(Buffer.from('two-'), false));
    reader.push(fragment(Buffer.from('three'), true));
    assert.equal(records.length, 1);
    assert.equal(records[0].toString(), 'one-two-three');
  });

  test('waits for a header that straddles chunks', () => {
    const records: Buffer[] = [];
    const reader = new RecordReader(1024, (r) => records.push(r));
    const wire = frameRecord(Buffer.from('xyz'));
    reader.push(wire.subarray(0, 2));
    reader.push(wire.subarray(2, 5));
    assert.equal(records.length, 0);
    reader.push(wire.subarray(5));
    assert.equal(records[0].toString(), 'xyz');
  });

  test('rejects a record over the limit, across fragments too', () => {
    const reader = new RecordReader(10, () => undefined);
    assert.throws(() => reader.push(frameRecord(Buffer.alloc(11))), XdrError);
    const spread = new RecordReader(10, () => undefined);
    spread.push(fragment(Buffer.alloc(6), false));
    assert.throws(() => spread.push(fragment(Buffer.alloc(6), true)), XdrError);
  });

  test('a record given out is not aliased to later input', () => {
    const records: Buffer[] = [];
    const reader = new RecordReader(1024, (r) => records.push(r));
    const chunk = Buffer.concat([
      frameRecord(Buffer.from('keep')),
      Buffer.from([0x80, 0, 0, 4]),
    ]);
    reader.push(chunk);
    chunk.fill(0);
    assert.equal(records[0].toString(), 'keep');
  });
});

describe('parseCall', () => {
  test('parses AUTH_SYS credentials', () => {
    const cred = new XdrWriter()
      .uint32(123)
      .string('box')
      .uint32(1000)
      .uint32(100)
      .uint32(2)
      .uint32(4)
      .uint32(27)
      .bytes();
    const args = new XdrWriter().uint32(99).bytes();
    const call = parseCall(
      callRecord({ xid: 42, flavor: AUTH_SYS, cred, args, proc: 5 }),
    );
    assert.equal(call.xid, 42);
    assert.equal(call.proc, 5);
    assert.equal(call.authFlavor, AUTH_SYS);
    assert.deepEqual(call.authSys, {
      stamp: 123,
      machine: 'box',
      uid: 1000,
      gid: 100,
      gids: [4, 27],
    });
    assert.equal(call.args.uint32(), 99);
    assert.equal(call.args.done(), true);
  });

  test('AUTH_NONE carries no credentials', () => {
    const call = parseCall(callRecord({}));
    assert.equal(call.authSys, undefined);
  });

  test('an unsupported RPC version is denied with the supported range', () => {
    assert.throws(
      () => parseCall(callRecord({ xid: 9, rpcVersion: 3 })),
      (err: RpcError) => {
        assert.ok(err instanceof RpcError);
        const r = new XdrReader(err.reply);
        assert.equal(r.uint32(), 9);
        assert.equal(r.uint32(), MSG_REPLY);
        assert.equal(r.uint32(), REPLY_DENIED);
        assert.equal(r.uint32(), REJECT_RPC_MISMATCH);
        assert.deepEqual([r.uint32(), r.uint32()], [2, 2]);
        return true;
      },
    );
  });

  test('a reply or a truncated header is an XDR error', () => {
    assert.throws(
      () => parseCall(callRecord({ msgType: MSG_REPLY })),
      XdrError,
    );
    assert.throws(() => parseCall(callRecord({}).subarray(0, 20)), XdrError);
  });

  test('frameRecord marks the single fragment as last', () => {
    const wire = frameRecord(Buffer.alloc(5));
    assert.equal(wire.readUInt32BE(0), (0x80000000 | 5) >>> 0);
    assert.equal(wire.length, 9);
  });
});

describe('RpcServer', () => {
  const PROG = 200001;
  let server: RpcServer;
  let port: number;

  before(async () => {
    server = new RpcServer({
      program: {
        prog: PROG,
        versions: [2, 3],
        async call(call) {
          switch (call.proc) {
            case 0:
              return Buffer.alloc(0);
            case 1: {
              const value = call.args.uint32();
              const delay = call.args.uint32();
              if (delay) await new Promise((r) => setTimeout(r, delay));
              return new XdrWriter()
                .uint32(value * 2)
                .uint32(call.vers)
                .toBuffer();
            }
            case 2:
              throw new XdrError('bad args');
            case 3:
              throw new Error('boom');
            default:
              throw new RpcError(
                'no proc',
                encodeAccepted(call.xid, ACCEPT_PROC_UNAVAIL),
              );
          }
        },
      },
    });
    port = (await server.listen(0, '127.0.0.1')).port;
  });

  after(async () => server.close());

  const args = (value: number, delay = 0) =>
    new XdrWriter().uint32(value).uint32(delay).bytes();

  test('answers a call with the program result', async () => {
    const client = await NfsClient.connect(port);
    const reply = await client.rpc(1, args(21), { prog: PROG, vers: 3 });
    assert.equal(reply.replyStat, REPLY_ACCEPTED);
    assert.equal(reply.acceptStat, ACCEPT_SUCCESS);
    assert.deepEqual([reply.reader.uint32(), reply.reader.uint32()], [42, 3]);
    client.close();
  });

  test('reports unknown programs, versions and procedures', async () => {
    const client = await NfsClient.connect(port);
    assert.equal(
      (await client.rpc(1, args(1), { prog: PROG + 1, vers: 2 })).acceptStat,
      ACCEPT_PROG_UNAVAIL,
    );
    const mismatch = await client.rpc(1, args(1), { prog: PROG, vers: 9 });
    assert.equal(mismatch.acceptStat, ACCEPT_PROG_MISMATCH);
    assert.deepEqual(mismatch.mismatch, { low: 2, high: 3 });
    assert.equal(
      (await client.rpc(77, args(1), { prog: PROG, vers: 2 })).acceptStat,
      ACCEPT_PROC_UNAVAIL,
    );
    client.close();
  });

  test('maps decode failures and crashes to RPC accept statuses', async () => {
    const client = await NfsClient.connect(port);
    assert.equal(
      (await client.rpc(2, args(1), { prog: PROG, vers: 2 })).acceptStat,
      ACCEPT_GARBAGE_ARGS,
    );
    assert.equal(
      (await client.rpc(3, args(1), { prog: PROG, vers: 2 })).acceptStat,
      ACCEPT_SYSTEM_ERR,
    );
    client.close();
  });

  test('denies flavors it cannot verify and RPC versions it does not speak', async () => {
    const client = await NfsClient.connect(port);
    const gss = await client.rpc(1, args(1), {
      prog: PROG,
      vers: 2,
      authFlavor: RPCSEC_GSS,
    });
    assert.equal(gss.replyStat, REPLY_DENIED);
    assert.equal(gss.rejectStat, REJECT_AUTH_ERROR);
    assert.equal(gss.authStat, AUTH_STAT_TOOWEAK);
    const old = await client.rpc(1, args(1), {
      prog: PROG,
      vers: 2,
      rpcVersion: 1,
    });
    assert.equal(old.replyStat, REPLY_DENIED);
    assert.deepEqual(old.mismatch, { low: 2, high: 2 });
    client.close();
  });

  test('pipelined calls are matched by xid even when answered out of order', async () => {
    const client = await NfsClient.connect(port);
    const replies = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        client
          .rpc(1, args(i, i % 2 === 0 ? 30 : 0), { prog: PROG, vers: 2 })
          .then((r) => ({
            i,
            value: r.reader.uint32(),
          })),
      ),
    );
    for (const { i, value } of replies) assert.equal(value, i * 2);
    client.close();
  });

  test('a peer the allow list rejects is closed before speaking', async () => {
    const gated = new RpcServer({
      program: {
        prog: PROG,
        versions: [2, 2],
        call: async () => Buffer.alloc(0),
      },
      allow: () => false,
    });
    const gatedPort = (await gated.listen(0, '127.0.0.1')).port;
    const client = await NfsClient.connect(gatedPort);
    assert.equal(await client.closedByPeer(), true);
    await gated.close();
  });

  test('an oversized record drops the connection', async () => {
    const client = await NfsClient.connect(port);
    const pending = client.rpc(1, Buffer.alloc(2 * 1024 * 1024), {
      prog: PROG,
      vers: 2,
    });
    await assert.rejects(pending, /closed/);
    client.close();
  });
});
