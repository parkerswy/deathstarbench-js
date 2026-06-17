'use strict';

// Integration: exercise a real handler (real Mongo + Memcached) over an actual
// framed/binary Thrift server+client, replacing the stubbed-handler interop test.
// Run with: npm run test:integration

const assert = require('node:assert/strict');
const test = require('node:test');
const thrift = require('thrift');

const CastInfoService = require('../../gen-nodejs/CastInfoService');
const { toBigInt, toLong, toWire } = require('../../src/lib/i64');
const { connectMongo } = require('../../src/lib/mongo');
const { createMemcached } = require('../../src/lib/memcached');
const { CastInfoHandler } = require('../../src/services/catalog');
const { tracer } = require('../helpers');
const { skip, uniqueId } = require('./itHelpers');

const wireOptions = { transport: thrift.TFramedTransport, protocol: thrift.TBinaryProtocol };

test('CastInfo round-trips i64 through the real handler over framed/binary Thrift', { skip }, async (t) => {
  const db = await connectMongo('cast-info');
  const cache = createMemcached('cast-info');
  const handler = new CastInfoHandler({ cache, collection: db.collection, tracer });
  const id = uniqueId();
  await handler.WriteCastInfo(toWire(1n), toWire(id), 'Actor', true, 'bio', {});

  const server = thrift.createServer(CastInfoService, handler, wireOptions);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const connection = thrift.createConnection('127.0.0.1', port, wireOptions);
  connection.on('error', () => {});
  const client = thrift.createClient(CastInfoService, connection);

  t.after(async () => {
    connection.end();
    await new Promise((resolve) => server.close(resolve));
    await db.collection.deleteOne({ cast_info_id: toLong(id) });
    await db.close();
    cache.close();
  });

  const result = await client.ReadCastInfo(toWire(1n), [toWire(id)], {});
  assert.equal(toBigInt(result[0].cast_info_id), id);
  assert.equal(result[0].name, 'Actor');
  assert.equal(result[0].gender, true);
});
