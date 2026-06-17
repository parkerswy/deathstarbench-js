'use strict';

// Parity: ServiceException messages and error codes must match the C++ handlers
// verbatim. Each case cites the source handler under mediaMicroservices/src.

const assert = require('node:assert/strict');
const test = require('node:test');

const Types = require('../../gen-nodejs/media_service_types');
const { toWire } = require('../../src/lib/i64');
const { CastInfoHandler, MovieInfoHandler, PlotHandler } = require('../../src/services/catalog');
const { MovieIdHandler } = require('../../src/services/pipeline');
const { ReviewStorageHandler } = require('../../src/services/reviewStorage');
const { UserHandler } = require('../../src/services/user');
const { MemoryCache, MemoryCollection, recordingClient, tracer } = require('../helpers');

const EMPTY_FINDONE = { findOne: async () => null };

async function expect(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof Types.ServiceException, 'expected ServiceException');
    assert.equal(error.errorCode, Types.ErrorCode[code], `error code for: ${message}`);
    assert.equal(error.message, message);
    return true;
  });
}

test('MovieIdHandler.UploadMovieId not-found message', async () => {
  // MovieIdHandler.h: "Movie " + title + " is not found in MongoDB"
  const handler = new MovieIdHandler({
    cache: new MemoryCache(), collection: EMPTY_FINDONE,
    compose: recordingClient(), rating: recordingClient(), tracer
  });
  await expect(handler.UploadMovieId(toWire(1n), 'ghost', 5, {}),
    'SE_THRIFT_HANDLER_ERROR', 'Movie ghost is not found in MongoDB');
});

test('MovieIdHandler.RegisterMovieId duplicate message', async () => {
  // MovieIdHandler.h: "Movie " + title + " already existed in MongoDB"
  const handler = new MovieIdHandler({
    cache: new MemoryCache(), collection: { findOne: async () => ({ movie_id: 'x' }) },
    compose: recordingClient(), rating: recordingClient(), tracer
  });
  await expect(handler.RegisterMovieId(toWire(1n), 'existing', 'm', {}),
    'SE_THRIFT_HANDLER_ERROR', 'Movie existing already existed in MongoDB');
});

test('ReviewStorageHandler.ReadReviews duplicate + incomplete messages', async () => {
  // ReviewStorageHandler.h: "Post_ids are duplicated" /
  //                         "review storage service: return set incomplete"
  const handler = new ReviewStorageHandler({
    cache: new MemoryCache(), collection: { find: () => ({ toArray: async () => [] }) }, tracer
  });
  await expect(handler.ReadReviews(toWire(1n), [toWire(5n), toWire(5n)], {}),
    'SE_THRIFT_HANDLER_ERROR', 'Post_ids are duplicated');
  await expect(handler.ReadReviews(toWire(1n), [toWire(404n)], {}),
    'SE_THRIFT_HANDLER_ERROR', 'review storage service: return set incomplete');
});

test('CastInfoHandler.ReadCastInfo duplicate + incomplete messages', async () => {
  // CastInfoHandler.h: "cast_info_ids are duplicated" /
  //                    "cast-info-service return set incomplete"
  const handler = new CastInfoHandler({
    cache: new MemoryCache(), collection: new MemoryCollection(), tracer
  });
  await expect(handler.ReadCastInfo(toWire(1n), [toWire(5n), toWire(5n)], {}),
    'SE_THRIFT_HANDLER_ERROR', 'cast_info_ids are duplicated');
  await expect(handler.ReadCastInfo(toWire(1n), [toWire(404n)], {}),
    'SE_THRIFT_HANDLER_ERROR', 'cast-info-service return set incomplete');
});

test('PlotHandler.ReadPlot not-found message', async () => {
  // PlotHandler.h: "Plot_id " + plot_id_str + " is not found in MongoDB"
  const handler = new PlotHandler({
    cache: new MemoryCache(), collection: new MemoryCollection(), tracer
  });
  await expect(handler.ReadPlot(toWire(1n), toWire(1000n), {}),
    'SE_THRIFT_HANDLER_ERROR', 'Plot_id 1000 is not found in MongoDB');
});

test('MovieInfoHandler.ReadMovieInfo not-found message', async () => {
  // MovieInfoHandler.h: "Movie_id: " + movie_id + " doesn't exist in MongoDB"
  const handler = new MovieInfoHandler({
    cache: new MemoryCache(), collection: new MemoryCollection(), tracer
  });
  await expect(handler.ReadMovieInfo(toWire(1n), 'ghost', {}),
    'SE_THRIFT_HANDLER_ERROR', "Movie_id: ghost doesn't exist in MongoDB");
});

test('UserHandler messages: duplicate, unregistered, and unauthorized', async () => {
  // UserHandler.h:
  //   RegisterUser dup ............ SE_THRIFT_HANDLER_ERROR "User <u> already existed"
  //   UploadUserWithUsername ...... SE_THRIFT_HANDLER_ERROR "User: <u> is not registered"
  //   Login (no user) ............. SE_UNAUTHORIZED        "User: <u> is not registered"
  //   Login (bad password) ........ SE_UNAUTHORIZED        "Incorrect username or password"
  const base = {
    cache: new MemoryCache(), compose: recordingClient(),
    generator: { next: () => 1n }, secret: 'secret', tracer
  };
  await expect(
    new UserHandler({ ...base, collection: { findOne: async () => ({ username: 'fl' }) } })
      .RegisterUser(toWire(1n), 'F', 'L', 'fl', 'pw', {}),
    'SE_THRIFT_HANDLER_ERROR', 'User fl already existed');
  await expect(
    new UserHandler({ ...base, collection: EMPTY_FINDONE })
      .UploadUserWithUsername(toWire(1n), 'ghost', {}),
    'SE_THRIFT_HANDLER_ERROR', 'User: ghost is not registered');
  await expect(
    new UserHandler({ ...base, collection: EMPTY_FINDONE })
      .Login(toWire(1n), 'ghost', 'pw', {}),
    'SE_UNAUTHORIZED', 'User: ghost is not registered');
});
