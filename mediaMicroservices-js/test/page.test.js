'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Types = require('../gen-nodejs/media_service_types');
const { toBigInt, toWire } = require('../src/lib/i64');
const { MovieInfoHandler, PageHandler } = require('../src/services/catalog');
const { tracer } = require('./helpers');

test('PageService assembles metadata, reviews, cast data, and plot', async () => {
  const castId = 9007199254741031n;
  const plotId = 9007199254741033n;
  const handler = new PageHandler({
    tracer,
    movieInfo: {
      call: async () => new Types.MovieInfo({
        movie_id: 'movie',
        title: 'title',
        casts: [new Types.Cast({ cast_id: 1, character: 'lead', cast_info_id: toWire(castId) })],
        plot_id: toWire(plotId),
        thumbnail_ids: [],
        photo_ids: [],
        video_ids: [],
        avg_rating: 4,
        num_rating: 1
      })
    },
    movieReview: { call: async () => [] },
    castInfo: {
      call: async (method, reqId, values) => {
        assert.equal(toBigInt(values[0]), castId);
        return [new Types.CastInfo({ cast_info_id: values[0], name: 'actor', gender: true, intro: '' })];
      }
    },
    plot: {
      call: async (method, reqId, value) => {
        assert.equal(toBigInt(value), plotId);
        return 'plot';
      }
    }
  });
  const page = await handler.ReadPage(toWire(1n), 'movie', 0, 10, {});
  assert.equal(page.plot, 'plot');
  assert.equal(page.movie_info.title, 'title');
  assert.equal(toBigInt(page.cast_infos[0].cast_info_id), castId);
});

test('MovieInfo UpdateRating preserves the source social-graph collection path', async () => {
  let primaryReads = 0;
  let updated;
  let deleted;
  const handler = new MovieInfoHandler({
    tracer,
    cache: { delete: async (key) => { deleted = key; } },
    collection: { findOne: async () => { primaryReads += 1; } },
    ratingCollection: {
      findOne: async () => ({ avg_rating: 4, num_rating: 2 }),
      updateOne: async (query, update) => { updated = { query, update }; }
    }
  });

  await handler.UpdateRating(toWire(1n), 'movie', 5, 1, {});
  assert.equal(primaryReads, 0);
  assert.deepEqual(updated, {
    query: { movie_id: 'movie' },
    update: { $set: { avg_rating: 13 / 3, num_rating: 3 } }
  });
  assert.equal(deleted, 'movie');
});

test('PageService handles a movie with no reviews or cast', async () => {
  let castIds;
  const handler = new PageHandler({
    tracer,
    movieInfo: {
      call: async () => new Types.MovieInfo({
        movie_id: 'movie', title: 'title', casts: [], plot_id: toWire(1n),
        thumbnail_ids: [], photo_ids: [], video_ids: [], avg_rating: 0, num_rating: 0
      })
    },
    movieReview: { call: async () => [] },
    castInfo: { call: async (method, reqId, ids) => { castIds = ids; return []; } },
    plot: { call: async () => 'plot' }
  });
  const page = await handler.ReadPage(toWire(1n), 'movie', 0, 10, {});
  assert.deepEqual(page.reviews, []);
  assert.deepEqual(page.cast_infos, []);
  assert.deepEqual(castIds, []);
});

test('PageService propagates a downstream failure', async () => {
  const handler = new PageHandler({
    tracer,
    movieInfo: { call: async () => { throw new Error('movie-info down'); } },
    movieReview: { call: async () => [] },
    castInfo: { call: async () => [] },
    plot: { call: async () => '' }
  });
  await assert.rejects(handler.ReadPage(toWire(1n), 'movie', 0, 10, {}), /movie-info down/);
});
