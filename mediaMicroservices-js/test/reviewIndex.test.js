'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Long } = require('mongodb');

const { toBigInt, toLong, toWire } = require('../src/lib/i64');
const { MovieReviewHandler, UserReviewHandler } = require('../src/services/reviewIndex');
const { MemoryCollection, MemoryRedis, recordingClient, tracer } = require('./helpers');

function movieHandler(parts = {}) {
  return new MovieReviewHandler({
    collection: parts.collection || new MemoryCollection(),
    redis: parts.redis || new MemoryRedis(),
    reviewStorage: parts.reviewStorage || recordingClient(),
    tracer,
    keyField: 'movie_id',
    spanPrefix: 'Movie'
  });
}

test('UploadMovieReview prepends to Mongo and skips Redis when the zset is empty', async () => {
  const collection = new MemoryCollection();
  const redis = new MemoryRedis();
  const handler = movieHandler({ collection, redis });
  await handler.UploadMovieReview(toWire(1n), 'movie-1', toWire(501n), toWire(1700000000000n), {});
  const doc = collection.docs[0];
  assert.equal(doc.reviews.length, 1);
  assert.equal(toBigInt(doc.reviews[0].review_id), 501n);
  assert.equal(await redis.zCard('movie-1'), 0); // gated: no zAdd until the zset is warm
});

test('UploadMovieReview keeps newest reviews at position 0', async () => {
  const collection = new MemoryCollection();
  const handler = movieHandler({ collection });
  await handler.UploadMovieReview(toWire(1n), 'm', toWire(601n), toWire(1700000000001n), {});
  await handler.UploadMovieReview(toWire(2n), 'm', toWire(602n), toWire(1700000000002n), {});
  const doc = collection.docs[0];
  assert.deepEqual(doc.reviews.map((r) => toBigInt(r.review_id)), [602n, 601n]);
});

test('UploadMovieReview updates a warm Redis zset', async () => {
  const redis = new MemoryRedis();
  await redis.zAdd('m', [{ score: 1, value: '600' }]); // warm the zset
  const handler = movieHandler({ redis });
  await handler.UploadMovieReview(toWire(1n), 'm', toWire(601n), toWire(1700000000000n), {});
  assert.equal(await redis.zCard('m'), 2);
});

test('UploadUserReview keys Mongo on a Long user_id', async () => {
  const collection = new MemoryCollection();
  const handler = new UserReviewHandler({
    collection, redis: new MemoryRedis(), reviewStorage: recordingClient(),
    tracer, keyField: 'user_id', spanPrefix: 'User'
  });
  await handler.UploadUserReview(toWire(1n), toWire(701n), toWire(801n), toWire(1700000000000n), {});
  const doc = collection.docs[0];
  assert.ok(Long.isLong(doc.user_id));
  assert.equal(toBigInt(doc.user_id), 701n);
});

test('Read returns empty for non-positive ranges without hydrating reviews', async () => {
  const reviewStorage = recordingClient();
  const handler = movieHandler({ reviewStorage });
  assert.deepEqual(await handler.ReadMovieReviews(toWire(1n), 'm', 5, 5, {}), []);
  assert.deepEqual(await handler.ReadMovieReviews(toWire(1n), 'm', -1, 10, {}), []);
  assert.equal(reviewStorage.calls.length, 0);
});

test('Read pulls ids from Redis in reverse-chronological order', async () => {
  const redis = new MemoryRedis();
  await redis.zAdd('m', [
    { score: 1700000000001, value: '101' },
    { score: 1700000000002, value: '102' }
  ]);
  const reviewStorage = recordingClient((method, reqId, ids) => ids);
  const handler = movieHandler({ redis, reviewStorage });
  await handler.ReadMovieReviews(toWire(1n), 'm', 0, 2, {});
  const passedIds = reviewStorage.calls[0][2].map(toBigInt);
  assert.deepEqual(passedIds, [102n, 101n]);
});

test('ReadUserReviews hydrates from Redis using a Long-derived key', async () => {
  const redis = new MemoryRedis();
  await redis.zAdd('701', [
    { score: 1700000000001, value: '101' },
    { score: 1700000000002, value: '102' }
  ]);
  const reviewStorage = recordingClient((method, reqId, ids) => ids);
  const handler = new UserReviewHandler({
    collection: new MemoryCollection(), redis, reviewStorage,
    tracer, keyField: 'user_id', spanPrefix: 'User'
  });
  await handler.ReadUserReviews(toWire(1n), toWire(701n), 0, 2, {});
  assert.deepEqual(reviewStorage.calls[0][2].map(toBigInt), [102n, 101n]);
});

test('Read falls back to Mongo, hydrates ids, and rebuilds the Redis zset', async () => {
  const collection = new MemoryCollection([{
    movie_id: 'm',
    reviews: [
      { review_id: toLong(202n), timestamp: toLong(1700000000002n) },
      { review_id: toLong(201n), timestamp: toLong(1700000000001n) }
    ]
  }]);
  const redis = new MemoryRedis();
  const reviewStorage = recordingClient((method, reqId, ids) => ids);
  const handler = movieHandler({ collection, redis, reviewStorage });
  await handler.ReadMovieReviews(toWire(1n), 'm', 0, 2, {});
  const passedIds = reviewStorage.calls[0][2].map(toBigInt);
  assert.deepEqual(passedIds, [202n, 201n]);
  assert.equal(await redis.zCard('m'), 2); // rebuilt from Mongo
});
