'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const thrift = require('thrift');

const CastInfoService = require('../../gen-nodejs/CastInfoService');
const Types = require('../../gen-nodejs/media_service_types');
const { handlerError } = require('../../src/lib/errors');
const { toBigInt, toWire } = require('../../src/lib/i64');

test('framed/binary Thrift transfers precise i64 values through generated bindings', async (t) => {
  const server = thrift.createServer(CastInfoService, {
    WriteCastInfo(reqId, castId, name, gender, intro, carrier) {
      return Promise.resolve();
    },
    ReadCastInfo(reqId, castIds, carrier) {
      if (toBigInt(reqId) === 2n) {
        return Promise.reject(handlerError('declared failure'));
      }
      return Promise.resolve([new Types.CastInfo({
        cast_info_id: castIds[0],
        name: 'actor',
        gender: true,
        intro: 'intro'
      })]);
    }
  }, {
    transport: thrift.TFramedTransport,
    protocol: thrift.TBinaryProtocol
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const connection = thrift.createConnection('127.0.0.1', port, {
    transport: thrift.TFramedTransport,
    protocol: thrift.TBinaryProtocol
  });
  t.after(() => {
    connection.end();
    server.close();
  });
  const client = thrift.createClient(CastInfoService, connection);
  const value = 9007199254741111n;
  const result = await client.ReadCastInfo(toWire(value), [toWire(value)], {});
  assert.equal(toBigInt(result[0].cast_info_id), value);
  await assert.rejects(
    client.ReadCastInfo(toWire(2n), [toWire(value)], {}),
    (error) => error instanceof Types.ServiceException && error.message === 'declared failure'
  );
});
