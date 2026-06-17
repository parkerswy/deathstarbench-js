'use strict';

// Parity: rating aggregation math must match the C++ reference.
//   MovieInfoHandler.h (UpdateRating):
//     avg_rating = (avg_rating * num_rating + sum_uncommitted) / (num_rating + num_uncommitted)
//     num_rating += num_uncommitted
//   RatingHandler.h accumulates {movie}:uncommit_sum (+= rating) and {movie}:uncommit_num (+= 1).

const assert = require('node:assert/strict');
const test = require('node:test');

const { toWire } = require('../../src/lib/i64');
const { MovieInfoHandler } = require('../../src/services/catalog');
const { RatingHandler } = require('../../src/services/pipeline');
const { MemoryCollection, MemoryRedis, recordingClient, tracer } = require('../helpers');

function updateRating(existing) {
  let update;
  const handler = new MovieInfoHandler({
    cache: { delete: async () => {} },
    collection: new MemoryCollection(),
    ratingCollection: {
      findOne: async () => existing,
      updateOne: async (_query, applied) => { update = applied; }
    },
    tracer
  });
  return handler.UpdateRating(toWire(1n), 'movie', 5, 1, {}).then(() => update);
}

test('UpdateRating recomputes the weighted average like the C++ handler', async () => {
  const update = await updateRating({ avg_rating: 4, num_rating: 2 });
  assert.deepEqual(update, { $set: { avg_rating: (4 * 2 + 5) / 3, num_rating: 3 } });
});

test('UpdateRating handles a first rating from a zero baseline', async () => {
  const update = await updateRating({ avg_rating: 0, num_rating: 0 });
  assert.deepEqual(update, { $set: { avg_rating: 5, num_rating: 1 } });
});

test('RatingHandler accumulates uncommitted sum and count in Redis', async () => {
  const redis = new MemoryRedis();
  const handler = new RatingHandler({ compose: recordingClient(), redis, tracer });
  await handler.UploadRating(toWire(1n), 'movie', 3, {});
  await handler.UploadRating(toWire(2n), 'movie', 4, {});
  assert.equal(redis.strings.get('movie:uncommit_sum'), 7);
  assert.equal(redis.strings.get('movie:uncommit_num'), 2);
});
