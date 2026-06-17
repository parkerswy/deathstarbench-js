'use strict';

// Integration: behaviors that the in-memory mocks cannot prove — real Memcached
// add/increment atomicity, real Redis sorted-set ordering, real Mongo $position:0
// ordering and $slice projection. Run with: npm run test:integration

const assert = require('node:assert/strict');
const test = require('node:test');

const { toBigInt, toLong, toWire } = require('../../src/lib/i64');
const { connectMongo } = require('../../src/lib/mongo');
const { connectRedis } = require('../../src/lib/redis');
const { createMemcached } = require('../../src/lib/memcached');
const { wireReview } = require('../../src/services/common');
const { ComposeReviewHandler, RatingHandler } = require('../../src/services/pipeline');
const { MovieReviewHandler } = require('../../src/services/reviewIndex');
const { ReviewStorageHandler } = require('../../src/services/reviewStorage');
const { recordingClient, tracer } = require('../helpers');
const { skip, logger, uniqueId, uniqueName } = require('./itHelpers');

test('ComposeReview fan-in fires exactly once when components race on real Memcached', { skip }, async (t) => {
  const cache = createMemcached('compose-review');
  t.after(() => cache.close());
  const reviewStorage = recordingClient();
  const handler = new ComposeReviewHandler({
    cache, reviewStorage, userReview: recordingClient(), movieReview: recordingClient(), tracer
  });
  const reqId = toWire(uniqueId());
  await Promise.all([
    handler.UploadText(reqId, 'good movie', {}),
    handler.UploadRating(reqId, 4, {}),
    handler.UploadMovieId(reqId, uniqueName('movie'), {}),
    handler.UploadUniqueId(reqId, toWire(uniqueId()), {}),
    handler.UploadUserId(reqId, toWire(uniqueId()), {})
  ]);
  assert.equal(reviewStorage.calls.length, 1, 'review should be composed exactly once');
});

test('RatingHandler accumulates uncommitted counters in real Redis', { skip }, async (t) => {
  const redis = await connectRedis('rating', logger);
  t.after(() => redis.quit());
  const movieId = uniqueName('rating-movie');
  const handler = new RatingHandler({ compose: recordingClient(), redis, tracer });
  await handler.UploadRating(toWire(uniqueId()), movieId, 4, {});
  await handler.UploadRating(toWire(uniqueId()), movieId, 5, {});
  assert.equal(await redis.get(`${movieId}:uncommit_sum`), '9');
  assert.equal(await redis.get(`${movieId}:uncommit_num`), '2');
  await redis.del(`${movieId}:uncommit_sum`);
  await redis.del(`${movieId}:uncommit_num`);
});

test('ReviewStorage round-trips through real Mongo with Memcached backfill', { skip }, async (t) => {
  const db = await connectMongo('review-storage', 'review');
  const cache = createMemcached('review-storage');
  t.after(async () => { await db.close(); cache.close(); });
  const handler = new ReviewStorageHandler({ cache, collection: db.collection, tracer });
  const review = {
    review_id: uniqueId(), user_id: uniqueId(), req_id: uniqueId(),
    text: 'integration', movie_id: uniqueName('m'), rating: 5, timestamp: BigInt(Date.now())
  };
  await handler.StoreReview(toWire(1n), wireReview(review), {});

  const fromMongo = await handler.ReadReviews(toWire(1n), [toWire(review.review_id)], {});
  assert.equal(toBigInt(fromMongo[0].review_id), review.review_id);
  assert.equal(fromMongo[0].text, 'integration');
  // Second read is served from the Memcached backfill written by the first.
  assert.ok(await cache.get(`${review.review_id}`), 'review should be cached after first read');
  const fromCache = await handler.ReadReviews(toWire(1n), [toWire(review.review_id)], {});
  assert.equal(toBigInt(fromCache[0].review_id), review.review_id);

  await db.collection.deleteOne({ review_id: toLong(review.review_id) });
});

test('MovieReview keeps newest-first order and rebuilds Redis from Mongo', { skip }, async (t) => {
  const db = await connectMongo('movie-review');
  const redis = await connectRedis('movie-review', logger);
  t.after(async () => { await db.close(); await redis.quit(); });
  const reviewStorage = recordingClient((method, reqId, ids) => ids);
  const handler = new MovieReviewHandler({
    collection: db.collection, redis, reviewStorage, tracer,
    keyField: 'movie_id', spanPrefix: 'Movie'
  });
  const movieId = uniqueName('mr');
  const older = uniqueId();
  const newer = older + 1n;
  await handler.UploadMovieReview(toWire(1n), movieId, toWire(older), toWire(1700000000001n), {});
  await handler.UploadMovieReview(toWire(2n), movieId, toWire(newer), toWire(1700000000002n), {});

  const doc = await db.collection.findOne({ movie_id: movieId });
  assert.deepEqual(doc.reviews.map((r) => toBigInt(r.review_id)), [newer, older]);

  // Redis was cold during the uploads, so the read rebuilds it from Mongo (newest first).
  await handler.ReadMovieReviews(toWire(3n), movieId, 0, 2, {});
  const passed = reviewStorage.calls.at(-1)[2].map(toBigInt);
  assert.deepEqual(passed, [newer, older]);
  assert.equal(await redis.zCard(movieId), 2);

  await db.collection.deleteOne({ movie_id: movieId });
  await redis.del(movieId);
});
