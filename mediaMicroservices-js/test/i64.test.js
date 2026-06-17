'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Types = require('../gen-nodejs/media_service_types');
const Int64 = require('node-int64');

const { cacheError, dbError, redisError, serviceError } = require('../src/lib/errors');
const { key, timestamp, toBigInt, toLong, toWire } = require('../src/lib/i64');
const { IdGenerator, CUSTOM_EPOCH, MAX_SIGNED_I64, machineId } = require('../src/lib/idGenerator');
const { redisTimestampScore } = require('../src/services/reviewIndex');

test('i64 helpers preserve values outside JavaScript safe integer range', () => {
  const value = 9223372036854775807n;
  assert.equal(toBigInt(toWire(value)), value);
  assert.equal(toBigInt(toLong(value)), value);
  assert.equal(key(toWire(value)), `${value}`);
});

test('i64 helpers convert supported inputs and reject unsafe values', () => {
  assert.equal(toBigInt(42), 42n);
  assert.equal(toBigInt('42'), 42n);
  assert.equal(toBigInt(Buffer.from('ffffffffffffffff', 'hex')), -1n);
  assert.equal(toBigInt(Buffer.alloc(0)), 0n);
  assert.equal(toBigInt({ buffer: Buffer.from('fffffffffffffffe', 'hex') }), -2n);
  assert.equal(toBigInt(new Int64(Buffer.from('fffffffffffffffd', 'hex'))), -3n);
  assert.equal(typeof timestamp(), 'bigint');
  assert.throws(() => toBigInt(Number.MAX_SAFE_INTEGER + 1), RangeError);
  assert.throws(() => toBigInt(null), TypeError);
});

test('unique IDs preserve machine, timestamp, and per-millisecond counter bits', () => {
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

test('unique IDs reject clock regression and machineId returns three hex chars', () => {
  const defaultGenerator = new IdGenerator('001');
  assert.ok(defaultGenerator.next() > 0n);

  const generator = new IdGenerator('001');
  assert.equal(generator.next(CUSTOM_EPOCH + 10n) & 0xfffn, 0n);
  assert.throws(
    () => generator.next(CUSTOM_EPOCH + 9n),
    /Timestamps are not incremental/
  );
  assert.match(machineId(), /^[0-9a-f]{3}$/);
});

test('Redis timestamp score conversion rejects values JavaScript would round', () => {
  assert.equal(redisTimestampScore(1700000000000n), 1700000000000);
  assert.throws(
    () => redisTimestampScore(9007199254740993n),
    /cannot be sorted precisely in Redis/
  );
});

test('service error helpers create typed ServiceException values', () => {
  assert.equal(serviceError('SE_THRIFT_HANDLER_ERROR', 'handler').errorCode,
    Types.ErrorCode.SE_THRIFT_HANDLER_ERROR);
  assert.equal(dbError('mongo').errorCode, Types.ErrorCode.SE_MONGODB_ERROR);
  assert.equal(cacheError('cache').errorCode, Types.ErrorCode.SE_MEMCACHED_ERROR);
  const error = redisError('redis');
  assert.ok(error instanceof Types.ServiceException);
  assert.equal(error.errorCode, Types.ErrorCode.SE_REDIS_ERROR);
  assert.equal(error.message, 'redis');
});
