'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Types = require('../gen-nodejs/media_service_types');
const { toBigInt, toLong, toWire } = require('../src/lib/i64');
const { CastInfoHandler, MovieInfoHandler, PlotHandler } = require('../src/services/catalog');
const { MemoryCache, MemoryCollection, tracer } = require('./helpers');

// --- CastInfoService ---

function castDoc(id, name) {
  return { cast_info_id: toLong(id), name, gender: true, intro: `intro-${name}` };
}

test('WriteCastInfo stores a Long cast_info_id with metadata', async () => {
  const collection = new MemoryCollection();
  const handler = new CastInfoHandler({ cache: new MemoryCache(), collection, tracer });
  await handler.WriteCastInfo(toWire(1n), toWire(900n), 'Actor', true, 'bio', {});
  assert.equal(toBigInt(collection.inserts[0].cast_info_id), 900n);
  assert.equal(collection.inserts[0].name, 'Actor');
});

test('ReadCastInfo serves a cache hit without querying Mongo', async () => {
  const cache = new MemoryCache();
  await cache.set('900', JSON.stringify({ cast_info_id: '900', name: 'A', gender: true, intro: 'i' }));
  const collection = new MemoryCollection();
  const handler = new CastInfoHandler({ cache, collection, tracer });
  const result = await handler.ReadCastInfo(toWire(1n), [toWire(900n)], {});
  assert.equal(collection.finds, 0);
  assert.equal(toBigInt(result[0].cast_info_id), 900n);
  assert.ok(result[0] instanceof Types.CastInfo);
});

test('ReadCastInfo falls back to Mongo and backfills the cache', async () => {
  const cache = new MemoryCache();
  const collection = new MemoryCollection([castDoc(900n, 'A')]);
  const handler = new CastInfoHandler({ cache, collection, tracer });
  const result = await handler.ReadCastInfo(toWire(1n), [toWire(900n)], {});
  assert.equal(toBigInt(result[0].cast_info_id), 900n);
  assert.ok(await cache.get('900'), 'cast info should be backfilled into cache');
});

test('ReadCastInfo preserves requested order regardless of Mongo order', async () => {
  const collection = new MemoryCollection([castDoc(902n, 'B'), castDoc(901n, 'A')]);
  const handler = new CastInfoHandler({ cache: new MemoryCache(), collection, tracer });
  const result = await handler.ReadCastInfo(toWire(1n), [toWire(901n), toWire(902n)], {});
  assert.deepEqual(result.map((c) => toBigInt(c.cast_info_id)), [901n, 902n]);
});

test('ReadCastInfo rejects duplicated ids', async () => {
  const handler = new CastInfoHandler({
    cache: new MemoryCache(), collection: new MemoryCollection(), tracer
  });
  await assert.rejects(
    handler.ReadCastInfo(toWire(1n), [toWire(5n), toWire(5n)], {}),
    (error) => error instanceof Types.ServiceException &&
      error.message === 'cast_info_ids are duplicated'
  );
});

test('ReadCastInfo rejects an incomplete result set', async () => {
  const handler = new CastInfoHandler({
    cache: new MemoryCache(), collection: new MemoryCollection(), tracer
  });
  await assert.rejects(
    handler.ReadCastInfo(toWire(1n), [toWire(404n)], {}),
    (error) => error instanceof Types.ServiceException &&
      error.errorCode === Types.ErrorCode.SE_THRIFT_HANDLER_ERROR
  );
});

// --- PlotService ---

test('WritePlot stores a Long plot_id with text', async () => {
  const collection = new MemoryCollection();
  const handler = new PlotHandler({ cache: new MemoryCache(), collection, tracer });
  await handler.WritePlot(toWire(1n), toWire(1000n), 'once upon a time', {});
  assert.equal(toBigInt(collection.inserts[0].plot_id), 1000n);
  assert.equal(collection.inserts[0].plot, 'once upon a time');
});

test('ReadPlot serves a cache hit without querying Mongo', async () => {
  const cache = new MemoryCache();
  await cache.set('1000', 'cached plot');
  const collection = new MemoryCollection();
  const handler = new PlotHandler({ cache, collection, tracer });
  assert.equal(await handler.ReadPlot(toWire(1n), toWire(1000n), {}), 'cached plot');
  assert.equal(collection.findOnes, 0);
});

test('ReadPlot falls back to Mongo and backfills the cache', async () => {
  const cache = new MemoryCache();
  const collection = new MemoryCollection([{ plot_id: toLong(1000n), plot: 'stored plot' }]);
  const handler = new PlotHandler({ cache, collection, tracer });
  assert.equal(await handler.ReadPlot(toWire(1n), toWire(1000n), {}), 'stored plot');
  assert.equal((await cache.get('1000')).toString(), 'stored plot');
});

test('ReadPlot raises a handler error when the plot is missing', async () => {
  const handler = new PlotHandler({
    cache: new MemoryCache(), collection: new MemoryCollection(), tracer
  });
  await assert.rejects(
    handler.ReadPlot(toWire(1n), toWire(1000n), {}),
    (error) => error instanceof Types.ServiceException &&
      error.message === 'Plot_id 1000 is not found in MongoDB'
  );
});

// --- MovieInfoService ---

function movieDoc() {
  return {
    movie_id: 'movie-1',
    title: 'Title',
    casts: [{ cast_id: 1, character: 'lead', cast_info_id: toLong(900n) }],
    plot_id: toLong(1000n),
    thumbnail_ids: ['t1'],
    photo_ids: ['p1'],
    video_ids: ['v1'],
    avg_rating: 4.5,
    num_rating: 2
  };
}

test('WriteMovieInfo maps casts to Long ids and parses avg_rating', async () => {
  const collection = new MemoryCollection();
  const handler = new MovieInfoHandler({ cache: new MemoryCache(), collection, tracer });
  await handler.WriteMovieInfo(
    toWire(1n), 'movie-1', 'Title',
    [new Types.Cast({ cast_id: 1, character: 'lead', cast_info_id: toWire(900n) })],
    toWire(1000n), ['t1'], ['p1'], ['v1'], '4.5', 2, {}
  );
  const inserted = collection.inserts[0];
  assert.equal(toBigInt(inserted.casts[0].cast_info_id), 900n);
  assert.equal(inserted.avg_rating, 4.5);
  assert.equal(inserted.num_rating, 2);
});

test('ReadMovieInfo falls back to Mongo and backfills the cache', async () => {
  const cache = new MemoryCache();
  const collection = new MemoryCollection([movieDoc()]);
  const handler = new MovieInfoHandler({ cache, collection, tracer });
  const result = await handler.ReadMovieInfo(toWire(1n), 'movie-1', {});
  assert.ok(result instanceof Types.MovieInfo);
  assert.equal(toBigInt(result.plot_id), 1000n);
  assert.equal(toBigInt(result.casts[0].cast_info_id), 900n);
  assert.ok(await cache.get('movie-1'), 'movie info should be backfilled into cache');
});

test('ReadMovieInfo serves a cache hit without querying Mongo', async () => {
  const cache = new MemoryCache();
  await cache.set('movie-1', JSON.stringify({
    movie_id: 'movie-1', title: 'Title',
    casts: [{ cast_id: 1, character: 'lead', cast_info_id: '900' }],
    plot_id: '1000', thumbnail_ids: [], photo_ids: [], video_ids: [],
    avg_rating: 4.5, num_rating: 2
  }));
  const collection = new MemoryCollection();
  const handler = new MovieInfoHandler({ cache, collection, tracer });
  const result = await handler.ReadMovieInfo(toWire(1n), 'movie-1', {});
  assert.equal(collection.findOnes, 0);
  assert.equal(toBigInt(result.casts[0].cast_info_id), 900n);
});

test('ReadMovieInfo raises a handler error when the movie is missing', async () => {
  const handler = new MovieInfoHandler({
    cache: new MemoryCache(), collection: new MemoryCollection(), tracer
  });
  await assert.rejects(
    handler.ReadMovieInfo(toWire(1n), 'ghost', {}),
    (error) => error instanceof Types.ServiceException &&
      error.message === "Movie_id: ghost doesn't exist in MongoDB"
  );
});

test('UpdateRating only invalidates the cache when the movie is absent', async () => {
  let deleted;
  let updated = false;
  const handler = new MovieInfoHandler({
    cache: { delete: async (key) => { deleted = key; } },
    collection: new MemoryCollection(),
    ratingCollection: {
      findOne: async () => null,
      updateOne: async () => { updated = true; }
    },
    tracer
  });
  await handler.UpdateRating(toWire(1n), 'movie-1', 5, 1, {});
  assert.equal(updated, false);
  assert.equal(deleted, 'movie-1');
});
