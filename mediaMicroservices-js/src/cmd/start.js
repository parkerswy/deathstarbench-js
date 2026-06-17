'use strict';

const CastInfoService = require('../../gen-nodejs/CastInfoService');
const ComposeReviewService = require('../../gen-nodejs/ComposeReviewService');
const MovieIdService = require('../../gen-nodejs/MovieIdService');
const MovieInfoService = require('../../gen-nodejs/MovieInfoService');
const MovieReviewService = require('../../gen-nodejs/MovieReviewService');
const PageService = require('../../gen-nodejs/PageService');
const PlotService = require('../../gen-nodejs/PlotService');
const RatingService = require('../../gen-nodejs/RatingService');
const ReviewStorageService = require('../../gen-nodejs/ReviewStorageService');
const TextService = require('../../gen-nodejs/TextService');
const UniqueIdService = require('../../gen-nodejs/UniqueIdService');
const UserReviewService = require('../../gen-nodejs/UserReviewService');
const UserService = require('../../gen-nodejs/UserService');

const { config } = require('../lib/config');
const { IdGenerator, machineId } = require('../lib/idGenerator');
const { createLogger } = require('../lib/logger');
const { createMemcached } = require('../lib/memcached');
const { connectMongo, uniqueIndex } = require('../lib/mongo');
const { connectRedis } = require('../lib/redis');
const { createServiceClient, startServer } = require('../lib/thrift');
const { initTracing } = require('../lib/tracing');
const { CastInfoHandler, MovieInfoHandler, PageHandler, PlotHandler } = require('../services/catalog');
const { ComposeReviewHandler, MovieIdHandler, RatingHandler, TextHandler, UniqueIdHandler } = require('../services/pipeline');
const { ReviewStorageHandler } = require('../services/reviewStorage');
const { MovieReviewHandler, UserReviewHandler } = require('../services/reviewIndex');
const { UserHandler } = require('../services/user');

async function run(serviceName, build) {
  const logger = createLogger(serviceName);
  const tracer = initTracing(serviceName, logger);
  const resources = [];
  const own = (resource) => {
    resources.push(resource);
    return resource;
  };
  const mongo = async (name, databaseName = name) => own(await connectMongo(name, databaseName));
  const cache = (name) => own(createMemcached(name));
  const redis = async (name) => own(await connectRedis(name, logger));
  const client = (Service, name) => own(createServiceClient(Service, name));
  const { Service, handler } = await build({ cache, client, logger, mongo, redis, tracer });
  const server = startServer(Service, handler, serviceName, logger);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info({ signal }, 'Shutting down service');
    await new Promise((resolve) => server.close(resolve));
    for (const resource of resources.reverse()) {
      if (typeof resource.quit === 'function') {
        await resource.quit();
      } else if (typeof resource.close === 'function') {
        await resource.close();
      }
    }
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

const builders = {
  'unique-id-service': async ({ client, tracer }) => ({
    Service: UniqueIdService,
    handler: new UniqueIdHandler({
      compose: client(ComposeReviewService, 'compose-review-service'),
      generator: new IdGenerator(machineId()),
      tracer
    })
  }),
  'movie-id-service': async ({ cache, client, mongo, tracer }) => {
    const db = await mongo('movie-id');
    await uniqueIndex(db.collection, 'movie_id');
    await uniqueIndex(db.collection, 'title');
    return {
      Service: MovieIdService,
      handler: new MovieIdHandler({
        cache: cache('movie-id'),
        collection: db.collection,
        compose: client(ComposeReviewService, 'compose-review-service'),
        rating: client(RatingService, 'rating-service'),
        tracer
      })
    };
  },
  'text-service': async ({ client, tracer }) => ({
    Service: TextService,
    handler: new TextHandler({
      compose: client(ComposeReviewService, 'compose-review-service'), tracer
    })
  }),
  'rating-service': async ({ client, redis, tracer }) => ({
    Service: RatingService,
    handler: new RatingHandler({
      compose: client(ComposeReviewService, 'compose-review-service'),
      redis: await redis('rating'),
      tracer
    })
  }),
  'user-service': async ({ cache, client, mongo, tracer }) => {
    const db = await mongo('user');
    return {
      Service: UserService,
      handler: new UserHandler({
        cache: cache('user'),
        collection: db.collection,
        compose: client(ComposeReviewService, 'compose-review-service'),
        generator: new IdGenerator(machineId()),
        secret: config.secret,
        tracer
      })
    };
  },
  'compose-review-service': async ({ cache, client, tracer }) => ({
    Service: ComposeReviewService,
    handler: new ComposeReviewHandler({
      cache: cache('compose-review'),
      reviewStorage: client(ReviewStorageService, 'review-storage-service'),
      userReview: client(UserReviewService, 'user-review-service'),
      movieReview: client(MovieReviewService, 'movie-review-service'),
      tracer
    })
  }),
  'review-storage-service': async ({ cache, mongo, tracer }) => {
    const db = await mongo('review-storage', 'review');
    return {
      Service: ReviewStorageService,
      handler: new ReviewStorageHandler({
        cache: cache('review-storage'), collection: db.collection, tracer
      })
    };
  },
  'movie-review-service': async ({ client, mongo, redis, tracer }) => {
    const db = await mongo('movie-review');
    await uniqueIndex(db.collection, 'movie_id');
    return {
      Service: MovieReviewService,
      handler: new MovieReviewHandler({
        collection: db.collection,
        redis: await redis('movie-review'),
        reviewStorage: client(ReviewStorageService, 'review-storage-service'),
        tracer,
        keyField: 'movie_id',
        spanPrefix: 'Movie'
      })
    };
  },
  'user-review-service': async ({ client, mongo, redis, tracer }) => {
    const db = await mongo('user-review');
    await uniqueIndex(db.collection, 'user_id');
    return {
      Service: UserReviewService,
      handler: new UserReviewHandler({
        collection: db.collection,
        redis: await redis('user-review'),
        reviewStorage: client(ReviewStorageService, 'review-storage-service'),
        tracer,
        keyField: 'user_id',
        spanPrefix: 'User'
      })
    };
  },
  'cast-info-service': async ({ cache, mongo, tracer }) => {
    const db = await mongo('cast-info');
    await uniqueIndex(db.collection, 'cast_info_id');
    return {
      Service: CastInfoService,
      handler: new CastInfoHandler({
        cache: cache('cast-info'), collection: db.collection, tracer
      })
    };
  },
  'plot-service': async ({ cache, mongo, tracer }) => {
    const db = await mongo('plot');
    await uniqueIndex(db.collection, 'plot_id');
    return {
      Service: PlotService,
      handler: new PlotHandler({ cache: cache('plot'), collection: db.collection, tracer })
    };
  },
  'movie-info-service': async ({ cache, mongo, tracer }) => {
    const db = await mongo('movie-info');
    await uniqueIndex(db.collection, 'movie_id');
    return {
      Service: MovieInfoService,
      handler: new MovieInfoHandler({
        cache: cache('movie-info'),
        collection: db.collection,
        ratingCollection: db.client.db('social-graph').collection('social-graph'),
        tracer
      })
    };
  },
  'page-service': async ({ client, tracer }) => ({
    Service: PageService,
    handler: new PageHandler({
      movieInfo: client(MovieInfoService, 'movie-info-service'),
      movieReview: client(MovieReviewService, 'movie-review-service'),
      castInfo: client(CastInfoService, 'cast-info-service'),
      plot: client(PlotService, 'plot-service'),
      tracer
    })
  })
};

async function start(serviceName) {
  if (!builders[serviceName]) {
    throw new Error(`Unknown media service: ${serviceName}`);
  }
  await run(serviceName, builders[serviceName]);
}

module.exports = { start };
