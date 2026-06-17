'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Types = require('../gen-nodejs/media_service_types');
const { toBigInt, toWire } = require('../src/lib/i64');
const { reviewDocument, wireReview } = require('../src/services/common');
const {
  ReviewStorageHandler, decodeReview, encodeReview
} = require('../src/services/reviewStorage');
const { MemoryCache } = require('./helpers');

function review(overrides = {}) {
  return {
    review_id: 9007199254741301n,
    user_id: 9007199254741302n,
    req_id: 9007199254741303n,
    text: 'a review',
    movie_id: 'movie-1',
    rating: 5,
    timestamp: 1700000000000n,
    ...overrides
  };
}

test('encode/decode review round-trips i64 fields as strings', () => {
  const original = review();
  assert.deepEqual(decodeReview(encodeReview(original)), original);
});

test('StoreReview inserts the review with Long-typed i64 fields', async () => {
  const inserts = [];
  const handler = new ReviewStorageHandler({
    cache: new MemoryCache(),
    collection: { insertOne: async (doc) => inserts.push(doc) },
    tracer: { withSpan: (_n, c, fn) => fn(c) }
  });
  await handler.StoreReview(toWire(1n), wireReview(review()), {});
  assert.equal(inserts.length, 1);
  assert.equal(toBigInt(inserts[0].review_id), 9007199254741301n);
  assert.equal(inserts[0].movie_id, 'movie-1');
  assert.equal(inserts[0].rating, 5);
});

test('ReadReviews returns an empty list for no ids without touching storage', async () => {
  let findCalls = 0;
  const handler = new ReviewStorageHandler({
    cache: new MemoryCache(),
    collection: { find() { findCalls += 1; return { toArray: async () => [] }; } },
    tracer: { withSpan: (_n, c, fn) => fn(c) }
  });
  assert.deepEqual(await handler.ReadReviews(toWire(1n), [], {}), []);
  assert.equal(findCalls, 0);
});

test('ReadReviews serves a cache hit without querying Mongo', async () => {
  const cache = new MemoryCache();
  const stored = review();
  await cache.set(`${stored.review_id}`, encodeReview(stored));
  let findCalls = 0;
  const handler = new ReviewStorageHandler({
    cache,
    collection: { find() { findCalls += 1; return { toArray: async () => [] }; } },
    tracer: { withSpan: (_n, c, fn) => fn(c) }
  });
  const result = await handler.ReadReviews(toWire(1n), [toWire(stored.review_id)], {});
  assert.equal(findCalls, 0);
  assert.equal(result.length, 1);
  assert.ok(result[0] instanceof Types.Review);
  assert.equal(toBigInt(result[0].review_id), stored.review_id);
});

test('ReadReviews falls back to Mongo and backfills the cache', async () => {
  const cache = new MemoryCache();
  const stored = review();
  const handler = new ReviewStorageHandler({
    cache,
    collection: { find: () => ({ toArray: async () => [reviewDocument(stored)] }) },
    tracer: { withSpan: (_n, c, fn) => fn(c) }
  });
  const result = await handler.ReadReviews(toWire(1n), [toWire(stored.review_id)], {});
  assert.equal(result.length, 1);
  assert.equal(toBigInt(result[0].review_id), stored.review_id);
  assert.ok(await cache.get(`${stored.review_id}`), 'review should be backfilled into cache');
});

test('ReadReviews preserves the requested id order regardless of Mongo order', async () => {
  const first = review({ review_id: 9007199254741310n });
  const second = review({ review_id: 9007199254741320n });
  const handler = new ReviewStorageHandler({
    cache: new MemoryCache(),
    // Mongo returns them reversed.
    collection: { find: () => ({ toArray: async () => [reviewDocument(second), reviewDocument(first)] }) },
    tracer: { withSpan: (_n, c, fn) => fn(c) }
  });
  const result = await handler.ReadReviews(
    toWire(1n), [toWire(first.review_id), toWire(second.review_id)], {}
  );
  assert.deepEqual(result.map((r) => toBigInt(r.review_id)), [first.review_id, second.review_id]);
});

test('ReadReviews rejects duplicated ids', async () => {
  const handler = new ReviewStorageHandler({
    cache: new MemoryCache(),
    collection: { find: () => ({ toArray: async () => [] }) },
    tracer: { withSpan: (_n, c, fn) => fn(c) }
  });
  await assert.rejects(
    handler.ReadReviews(toWire(1n), [toWire(5n), toWire(5n)], {}),
    (error) => error instanceof Types.ServiceException &&
      error.errorCode === Types.ErrorCode.SE_THRIFT_HANDLER_ERROR &&
      error.message === 'Post_ids are duplicated'
  );
});

test('ReadReviews rejects an incomplete result set', async () => {
  const handler = new ReviewStorageHandler({
    cache: new MemoryCache(),
    collection: { find: () => ({ toArray: async () => [] }) },
    tracer: { withSpan: (_n, c, fn) => fn(c) }
  });
  await assert.rejects(
    handler.ReadReviews(toWire(1n), [toWire(404n)], {}),
    (error) => error instanceof Types.ServiceException &&
      error.errorCode === Types.ErrorCode.SE_THRIFT_HANDLER_ERROR
  );
});
