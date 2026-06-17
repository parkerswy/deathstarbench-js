'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const { Long } = require('mongodb');

const Types = require('../gen-nodejs/media_service_types');
const { toBigInt, toLong, toWire } = require('../src/lib/i64');
const { hashPassword } = require('../src/services/common');
const { UserHandler } = require('../src/services/user');
const { MemoryCache, recordingClient, tracer } = require('./helpers');

test('login populates cache after Mongo lookup and authenticates from cache', async () => {
  const cache = new MemoryCache();
  let finds = 0;
  const salt = 'salt-value';
  const collection = {
    async findOne() {
      finds += 1;
      return {
        user_id: Long.fromBigInt(9007199254741001n),
        salt,
        password: hashPassword('password', salt)
      };
    }
  };
  const handler = new UserHandler({
    cache,
    collection,
    compose: recordingClient(),
    generator: { next: () => 1n },
    secret: 'secret',
    tracer
  });
  const first = await handler.Login(toWire(1n), 'name', 'password', {});
  const second = await handler.Login(toWire(2n), 'name', 'password', {});
  assert.equal(finds, 1);
  assert.equal(jwt.verify(first, 'secret').user_id, '9007199254741001');
  assert.equal(jwt.verify(second, 'secret').user_id, '9007199254741001');
});

test('RegisterUser generates an id and stores a salted password hash', async () => {
  const inserts = [];
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection: { findOne: async () => null, insertOne: async (doc) => inserts.push(doc) },
    compose: recordingClient(),
    generator: { next: () => 9007199254742001n },
    secret: 'secret',
    tracer
  });
  await handler.RegisterUser(toWire(1n), 'First', 'Last', 'fl', 'pw', {});
  const stored = inserts[0];
  assert.equal(toBigInt(stored.user_id), 9007199254742001n);
  assert.equal(stored.salt.length, 32);
  assert.notEqual(stored.password, 'pw');
  assert.equal(stored.password, hashPassword('pw', stored.salt));
});

test('RegisterUserWithId stores the supplied id', async () => {
  const inserts = [];
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection: { findOne: async () => null, insertOne: async (doc) => inserts.push(doc) },
    compose: recordingClient(),
    generator: { next: () => 1n },
    secret: 'secret',
    tracer
  });
  await handler.RegisterUserWithId(toWire(1n), 'First', 'Last', 'fl', 'pw', toWire(42n), {});
  assert.equal(toBigInt(inserts[0].user_id), 42n);
});

test('RegisterUser rejects a duplicate username', async () => {
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection: { findOne: async () => ({ username: 'fl' }) },
    compose: recordingClient(),
    generator: { next: () => 1n },
    secret: 'secret',
    tracer
  });
  await assert.rejects(
    handler.RegisterUser(toWire(1n), 'First', 'Last', 'fl', 'pw', {}),
    (error) => error instanceof Types.ServiceException &&
      error.errorCode === Types.ErrorCode.SE_THRIFT_HANDLER_ERROR &&
      error.message === 'User fl already existed'
  );
});

test('UploadUserWithUserId forwards the id straight to compose-review', async () => {
  const compose = recordingClient();
  const handler = new UserHandler({
    cache: new MemoryCache(), collection: {}, compose,
    generator: { next: () => 1n }, secret: 'secret', tracer
  });
  await handler.UploadUserWithUserId(toWire(1n), toWire(555n), {});
  assert.equal(compose.calls[0][0], 'UploadUserId');
  assert.equal(toBigInt(compose.calls[0][2]), 555n);
});

test('UploadUserWithUsername resolves the id from cache without querying Mongo', async () => {
  const cache = new MemoryCache();
  await cache.set('fl:user_id', '777');
  const compose = recordingClient();
  let finds = 0;
  const handler = new UserHandler({
    cache,
    collection: { findOne: async () => { finds += 1; return null; } },
    compose, generator: { next: () => 1n }, secret: 'secret', tracer
  });
  await handler.UploadUserWithUsername(toWire(1n), 'fl', {});
  assert.equal(finds, 0);
  assert.equal(toBigInt(compose.calls[0][2]), 777n);
});

test('UploadUserWithUsername resolves the id from Mongo and caches it', async () => {
  const cache = new MemoryCache();
  const compose = recordingClient();
  const handler = new UserHandler({
    cache,
    collection: { findOne: async () => ({ user_id: toLong(888n) }) },
    compose, generator: { next: () => 1n }, secret: 'secret', tracer
  });
  await handler.UploadUserWithUsername(toWire(1n), 'fl', {});
  assert.equal(toBigInt(compose.calls[0][2]), 888n);
  assert.equal((await cache.get('fl:user_id')).toString(), '888');
});

test('UploadUserWithUsername rejects an unregistered user', async () => {
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection: { findOne: async () => null },
    compose: recordingClient(), generator: { next: () => 1n }, secret: 'secret', tracer
  });
  await assert.rejects(
    handler.UploadUserWithUsername(toWire(1n), 'ghost', {}),
    (error) => error instanceof Types.ServiceException &&
      error.message === 'User: ghost is not registered'
  );
});

test('Login rejects an incorrect password as unauthorized', async () => {
  const salt = 'salt-value';
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection: {
      findOne: async () => ({
        user_id: toLong(1n), salt, password: hashPassword('correct', salt)
      })
    },
    compose: recordingClient(), generator: { next: () => 1n }, secret: 'secret', tracer
  });
  await assert.rejects(
    handler.Login(toWire(1n), 'name', 'wrong', {}),
    (error) => error instanceof Types.ServiceException &&
      error.errorCode === Types.ErrorCode.SE_UNAUTHORIZED &&
      error.message === 'Incorrect username or password'
  );
});

test('Login rejects an unregistered user as unauthorized', async () => {
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection: { findOne: async () => null },
    compose: recordingClient(), generator: { next: () => 1n }, secret: 'secret', tracer
  });
  await assert.rejects(
    handler.Login(toWire(1n), 'ghost', 'pw', {}),
    (error) => error instanceof Types.ServiceException &&
      error.errorCode === Types.ErrorCode.SE_UNAUTHORIZED &&
      error.message === 'User: ghost is not registered'
  );
});
