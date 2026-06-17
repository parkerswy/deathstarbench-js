'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Types = require('../gen-nodejs/media_service_types');
const { toBigInt, toWire } = require('../src/lib/i64');
const {
  ComposeReviewHandler, MovieIdHandler, RatingHandler, TextHandler, UniqueIdHandler
} = require('../src/services/pipeline');
const { MemoryCache, MemoryRedis, recordingClient, tracer } = require('./helpers');

test('compose-review emits one complete review after five fragments arrive', async () => {
  const cache = new MemoryCache();
  const reviewStorage = recordingClient();
  const userReview = recordingClient();
  const movieReview = recordingClient();
  const handler = new ComposeReviewHandler({
    cache, reviewStorage, userReview, movieReview, tracer
  });
  const reqId = toWire(9007199254741009n);

  await Promise.all([
    handler.UploadText(reqId, 'good movie', {}),
    handler.UploadRating(reqId, 4, {}),
    handler.UploadMovieId(reqId, 'movie-1', {}),
    handler.UploadUniqueId(reqId, toWire(9007199254741011n), {}),
    handler.UploadUserId(reqId, toWire(9007199254741013n), {})
  ]);

  assert.equal(reviewStorage.calls.length, 1);
  const stored = reviewStorage.calls[0][2];
  assert.ok(stored instanceof Types.Review);
  assert.equal(toBigInt(stored.req_id), 9007199254741009n);
  assert.equal(toBigInt(stored.review_id), 9007199254741011n);
  assert.equal(toBigInt(stored.user_id), 9007199254741013n);
  assert.equal(stored.movie_id, 'movie-1');
  assert.equal(stored.text, 'good movie');
  assert.equal(stored.rating, 4);
  assert.equal(userReview.calls.length, 1);
  assert.equal(movieReview.calls.length, 1);
});

test('movie ID resolves from Mongo once then uses the cache and forwards rating', async () => {
  const cache = new MemoryCache();
  let finds = 0;
  const collection = {
    async findOne() {
      finds += 1;
      return { movie_id: 'movie-7' };
    }
  };
  const compose = recordingClient();
  const rating = recordingClient();
  const handler = new MovieIdHandler({ cache, collection, compose, rating, tracer });
  await handler.UploadMovieId(toWire(1n), 'title', 5, {});
  await handler.UploadMovieId(toWire(2n), 'title', 3, {});
  assert.equal(finds, 1);
  assert.equal(compose.calls.length, 2);
  assert.equal(rating.calls[1][3], 3);
});

test('declared service exception is raised for duplicate movie registration', async () => {
  const handler = new MovieIdHandler({
    cache: new MemoryCache(),
    collection: { findOne: async () => ({ movie_id: 'already' }) },
    compose: recordingClient(),
    rating: recordingClient(),
    tracer
  });
  await assert.rejects(
    handler.RegisterMovieId(toWire(1n), 'existing', 'movie', {}),
    (error) => error instanceof Types.ServiceException &&
      error.errorCode === Types.ErrorCode.SE_THRIFT_HANDLER_ERROR
  );
});

test('text service forwards review text to compose-review', async () => {
  const compose = recordingClient();
  const handler = new TextHandler({ compose, tracer });
  await handler.UploadText(toWire(7n), 'great film', {});
  assert.equal(compose.calls.length, 1);
  assert.deepEqual(compose.calls[0].slice(0, 3), ['UploadText', toWire(7n), 'great film']);
});

test('unique-id service generates an id and forwards it to compose-review', async () => {
  const compose = recordingClient();
  const handler = new UniqueIdHandler({
    compose, generator: { next: () => 9007199254741201n }, tracer
  });
  await handler.UploadUniqueId(toWire(7n), {});
  assert.equal(compose.calls.length, 1);
  assert.equal(compose.calls[0][0], 'UploadUniqueId');
  assert.equal(toBigInt(compose.calls[0][2]), 9007199254741201n);
});

test('rating service forwards to compose and accumulates uncommitted Redis counters', async () => {
  const compose = recordingClient();
  const redis = new MemoryRedis();
  const handler = new RatingHandler({ compose, redis, tracer });
  await handler.UploadRating(toWire(7n), 'movie-1', 4, {});
  await handler.UploadRating(toWire(8n), 'movie-1', 5, {});
  assert.equal(compose.calls.length, 2);
  assert.deepEqual(compose.calls[0].slice(0, 3), ['UploadRating', toWire(7n), 4]);
  assert.equal(redis.strings.get('movie-1:uncommit_sum'), 9);
  assert.equal(redis.strings.get('movie-1:uncommit_num'), 2);
});

test('movie ID lookup that misses both cache and Mongo raises a handler error', async () => {
  const handler = new MovieIdHandler({
    cache: new MemoryCache(),
    collection: { findOne: async () => null },
    compose: recordingClient(),
    rating: recordingClient(),
    tracer
  });
  await assert.rejects(
    handler.UploadMovieId(toWire(1n), 'ghost', 5, {}),
    (error) => error instanceof Types.ServiceException &&
      error.errorCode === Types.ErrorCode.SE_THRIFT_HANDLER_ERROR &&
      error.message === 'Movie ghost is not found in MongoDB'
  );
});

test('movie registration inserts a new title -> movie_id mapping', async () => {
  const inserted = [];
  const handler = new MovieIdHandler({
    cache: new MemoryCache(),
    collection: { findOne: async () => null, insertOne: async (doc) => inserted.push(doc) },
    compose: recordingClient(),
    rating: recordingClient(),
    tracer
  });
  await handler.RegisterMovieId(toWire(1n), 'Inception', 'tt1375666', {});
  assert.deepEqual(inserted, [{ title: 'Inception', movie_id: 'tt1375666' }]);
});

test('compose-review does not fan out before all five components arrive', async () => {
  const cache = new MemoryCache();
  const reviewStorage = recordingClient();
  const handler = new ComposeReviewHandler({
    cache, reviewStorage, userReview: recordingClient(), movieReview: recordingClient(), tracer
  });
  const reqId = toWire(11n);
  await handler.UploadText(reqId, 'good', {});
  await handler.UploadRating(reqId, 4, {});
  await handler.UploadMovieId(reqId, 'movie-1', {});
  await handler.UploadUniqueId(reqId, toWire(101n), {});
  assert.equal(reviewStorage.calls.length, 0);
});

test('compose-review counts a duplicated component only once', async () => {
  const cache = new MemoryCache();
  const reviewStorage = recordingClient();
  const handler = new ComposeReviewHandler({
    cache, reviewStorage, userReview: recordingClient(), movieReview: recordingClient(), tracer
  });
  const reqId = toWire(12n);
  await handler.UploadText(reqId, 'good', {});
  await handler.UploadText(reqId, 'good again', {}); // duplicate: must not advance the counter
  await handler.UploadRating(reqId, 4, {});
  await handler.UploadMovieId(reqId, 'movie-1', {});
  await handler.UploadUniqueId(reqId, toWire(101n), {});
  assert.equal(reviewStorage.calls.length, 0);
  await handler.UploadUserId(reqId, toWire(103n), {}); // fifth distinct component
  assert.equal(reviewStorage.calls.length, 1);
});

test('compose throws when the cached components are incomplete', async () => {
  const handler = new ComposeReviewHandler({
    cache: new MemoryCache(),
    reviewStorage: recordingClient(),
    userReview: recordingClient(),
    movieReview: recordingClient(),
    tracer
  });
  await assert.rejects(
    handler.compose(toWire(13n), {}),
    (error) => error instanceof Types.ServiceException &&
      error.errorCode === Types.ErrorCode.SE_THRIFT_HANDLER_ERROR
  );
});

