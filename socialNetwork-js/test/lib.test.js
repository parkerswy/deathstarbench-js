'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Int64 = require('node-int64');
const { Long } = require('mongodb');

const Types = require('../gen-nodejs/social_network_types');
const {
  cacheError,
  dbError,
  handlerError,
  redisError,
  serviceError,
  thriftError,
  unauthorizedError
} = require('../src/lib/errors');
const { key, timestamp, toBigInt, toLong, toWire } = require('../src/lib/i64');
const {
  CUSTOM_EPOCH,
  IdGenerator,
  MAX_SIGNED_I64,
  machineId
} = require('../src/lib/idGenerator');

test('i64 helpers preserve signed values outside JavaScript safe integer range', () => {
  const max = 9223372036854775807n;
  const min = -9223372036854775808n;

  assert.equal(toBigInt(toWire(max)), max);
  assert.equal(toBigInt(toWire(min)), min);
  assert.equal(toBigInt(toLong(max)), max);
  assert.equal(key(toWire(max)), `${max}`);
});

test('i64 helpers convert supported inputs and reject unsafe numbers', () => {
  assert.equal(toBigInt(42n), 42n);
  assert.equal(toBigInt(42), 42n);
  assert.equal(toBigInt('42'), 42n);
  assert.equal(toBigInt(Long.fromBigInt(43n)), 43n);
  assert.equal(toBigInt(Buffer.from('000000000000002c', 'hex')), 44n);
  assert.equal(toBigInt(Buffer.from('ffffffffffffffff', 'hex')), -1n);
  assert.equal(toBigInt(Buffer.alloc(0)), 0n);
  assert.equal(toBigInt(new Int64(Buffer.from('fffffffffffffffe', 'hex'))), -2n);
  assert.equal(toBigInt({ buffer: Buffer.from('fffffffffffffffd', 'hex') }), -3n);
  assert.equal(typeof timestamp(), 'bigint');

  assert.throws(() => toBigInt(Number.MAX_SAFE_INTEGER + 1), RangeError);
  assert.throws(() => toBigInt(null), TypeError);
});

test('unique IDs preserve machine, timestamp, and counter fields', () => {
  const generator = new IdGenerator('abc');
  const now = CUSTOM_EPOCH + 13n;
  const first = generator.next(now);
  const second = generator.next(now);

  assert.equal(first >> 52n, 0x2bcn);
  assert.equal((first >> 12n) & 0xffffffffffn, 13n);
  assert.equal(first & 0xfffn, 0n);
  assert.equal(second & 0xfffn, 1n);
  assert.equal(first <= MAX_SIGNED_I64, true);
  assert.doesNotThrow(() => toWire(first));
});

test('unique IDs reject clock regression and expose bounded machine IDs', () => {
  const defaultGenerator = new IdGenerator('001');
  assert.ok(defaultGenerator.next() > 0n);

  const generator = new IdGenerator('fff');
  const high = generator.next(CUSTOM_EPOCH + 0xffffffffffn);
  assert.equal(high <= MAX_SIGNED_I64, true);
  assert.equal(high >> 52n, 0x7ffn);

  const regression = new IdGenerator('001');
  assert.equal(regression.next(CUSTOM_EPOCH + 10n) & 0xfffn, 0n);
  assert.throws(
    () => regression.next(CUSTOM_EPOCH + 9n),
    /Timestamps are not incremental/
  );
  assert.match(machineId(), /^[0-9a-f]{3}$/);
});

test('service error helpers create typed ServiceException values', () => {
  const cases = [
    [serviceError('SE_THRIFT_HANDLER_ERROR', 'handler'), Types.ErrorCode.SE_THRIFT_HANDLER_ERROR, 'handler'],
    [dbError('mongo'), Types.ErrorCode.SE_MONGODB_ERROR, 'mongo'],
    [cacheError('cache'), Types.ErrorCode.SE_MEMCACHED_ERROR, 'cache'],
    [redisError('redis'), Types.ErrorCode.SE_REDIS_ERROR, 'redis'],
    [handlerError('handler helper'), Types.ErrorCode.SE_THRIFT_HANDLER_ERROR, 'handler helper'],
    [thriftError('thrift'), Types.ErrorCode.SE_THRIFT_CONN_ERROR, 'thrift'],
    [unauthorizedError('unauthorized'), Types.ErrorCode.SE_UNAUTHORIZED, 'unauthorized']
  ];

  for (const [error, code, message] of cases) {
    assert.ok(error instanceof Types.ServiceException);
    assert.equal(error.errorCode, code);
    assert.equal(error.message, message);
  }
});
