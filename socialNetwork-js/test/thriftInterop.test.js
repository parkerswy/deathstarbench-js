'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const thrift = require('thrift');

const MediaService = require('../gen-nodejs/MediaService');
const Types = require('../gen-nodejs/social_network_types');
const { handlerError } = require('../src/lib/errors');
const { toBigInt, toWire } = require('../src/lib/i64');

test('framed/binary Thrift preserves i64 values and declared exceptions', async (t) => {
  const server = thrift.createServer(MediaService, {
    ComposeMedia(reqId, mediaTypes, mediaIds, carrier) {
      if (toBigInt(reqId) === 2n) {
        return Promise.reject(handlerError('declared failure'));
      }
      return Promise.resolve([new Types.Media({
        media_id: mediaIds[0],
        media_type: mediaTypes[0]
      })]);
    }
  }, {
    transport: thrift.TFramedTransport,
    protocol: thrift.TBinaryProtocol
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const connection = thrift.createConnection('127.0.0.1', server.address().port, {
    transport: thrift.TFramedTransport,
    protocol: thrift.TBinaryProtocol
  });
  t.after(() => {
    connection.end();
    server.close();
  });

  const client = thrift.createClient(MediaService, connection);
  const value = 9007199254741111n;
  const result = await client.ComposeMedia(toWire(value), ['png'], [toWire(value)], {});
  assert.equal(toBigInt(result[0].media_id), value);
  await assert.rejects(
    client.ComposeMedia(toWire(2n), ['png'], [toWire(value)], {}),
    (error) => error instanceof Types.ServiceException && error.message === 'declared failure'
  );
});
