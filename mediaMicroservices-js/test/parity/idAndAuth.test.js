'use strict';

// Parity: identity generation and authentication must match the C++ reference.
//   - ID layout: mediaMicroservices/src/UserService/UserHandler.h (CUSTOM_EPOCH,
//     machine_id(3 hex) + timestamp(10 hex) + counter(3 hex), masked with 0x7FFF...)
//   - Password: picosha2::hash256_hex_string(password + salt)  -> sha256 hex
//   - JWT: payload {user_id, timestamp, TTL:"60000"} signed HS256

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const { Long } = require('mongodb');

const { CUSTOM_EPOCH, IdGenerator, MAX_SIGNED_I64 } = require('../../src/lib/idGenerator');
const { hashPassword } = require('../../src/services/common');
const { UserHandler } = require('../../src/services/user');
const { MemoryCache, recordingClient, tracer } = require('../helpers');

test('custom epoch matches the C++ 2018-01-01 epoch', () => {
  assert.equal(CUSTOM_EPOCH, 1514764800000n);
  assert.equal(CUSTOM_EPOCH, BigInt(Date.UTC(2018, 0, 1)));
});

test('generated id equals the C++ machine|timestamp|counter hex composition', () => {
  const machine = 'abc';
  const generator = new IdGenerator(machine);
  const elapsed = 0x1234n;
  const now = CUSTOM_EPOCH + elapsed;

  const reference = (counter) => {
    const tsHex = elapsed.toString(16).padStart(10, '0').slice(-10);
    const counterHex = counter.toString(16).padStart(3, '0').slice(-3);
    return BigInt(`0x${machine}${tsHex}${counterHex}`) & MAX_SIGNED_I64;
  };

  assert.equal(generator.next(now), reference(0));      // first id this ms -> counter 0
  assert.equal(generator.next(now), reference(1));      // same ms -> counter increments
});

test('generated id is always a positive signed i64', () => {
  const generator = new IdGenerator('fff'); // high bits set before masking
  const id = generator.next(CUSTOM_EPOCH + 0xffffffffffn);
  assert.ok(id > 0n && id <= MAX_SIGNED_I64);
});

test('password hashing matches picosha2 sha256(password + salt) hex', () => {
  const expected = crypto.createHash('sha256').update('secretsalt123').digest('hex');
  assert.equal(hashPassword('secret', 'salt123'), expected);
});

test('Login issues an HS256 JWT with the C++ payload shape', async () => {
  const salt = 'salt-value';
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection: {
      findOne: async () => ({
        user_id: Long.fromBigInt(9007199254741001n),
        salt,
        password: hashPassword('password', salt)
      })
    },
    compose: recordingClient(),
    generator: { next: () => 1n },
    secret: 'secret',
    tracer
  });
  const token = await handler.Login({}, 'name', 'password', {});
  const decoded = jwt.decode(token, { complete: true });
  assert.equal(decoded.header.alg, 'HS256');
  assert.equal(decoded.payload.user_id, '9007199254741001');
  assert.equal(typeof decoded.payload.user_id, 'string');
  assert.equal(typeof decoded.payload.timestamp, 'string');
  assert.equal(decoded.payload.TTL, '60000');
});
