'use strict';

const ComposePostService = require('../../gen-nodejs/ComposePostService');
const HomeTimelineService = require('../../gen-nodejs/HomeTimelineService');
const MediaService = require('../../gen-nodejs/MediaService');
const PostStorageService = require('../../gen-nodejs/PostStorageService');
const SocialGraphService = require('../../gen-nodejs/SocialGraphService');
const TextService = require('../../gen-nodejs/TextService');
const UniqueIdService = require('../../gen-nodejs/UniqueIdService');
const UrlShortenService = require('../../gen-nodejs/UrlShortenService');
const UserMentionService = require('../../gen-nodejs/UserMentionService');
const UserService = require('../../gen-nodejs/UserService');
const UserTimelineService = require('../../gen-nodejs/UserTimelineService');

const { config } = require('../lib/config');
const { IdGenerator, machineId } = require('../lib/idGenerator');
const { createLogger } = require('../lib/logger');
const { createMemcached } = require('../lib/memcached');
const { connectMongo, uniqueIndex } = require('../lib/mongo');
const { connectRedis } = require('../lib/redis');
const { createServiceClient, startServer } = require('../lib/thrift');
const { initTracing } = require('../lib/tracing');
const { ComposePostHandler, UniqueIdHandler } = require('../services/compose');
const { PostStorageHandler } = require('../services/postStorage');
const { SocialGraphHandler } = require('../services/socialGraph');
const { HomeTimelineHandler, UserTimelineHandler } = require('../services/timeline');
const { MediaHandler, TextHandler, UrlShortenHandler, UserMentionHandler } = require('../services/text');
const { UserHandler } = require('../services/user');

async function run(serviceName, build) {
  const logger = createLogger(serviceName);
  const tracer = initTracing(serviceName, logger);
  const resources = [];
  const own = (resource) => {
    resources.push(resource);
    return resource;
  };
  const mongo = async (endpoint, databaseName = endpoint, collectionName = databaseName) =>
    own(await connectMongo(endpoint, databaseName, collectionName));
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
  'unique-id-service': async ({ tracer }) => ({
    Service: UniqueIdService,
    handler: new UniqueIdHandler({ generator: new IdGenerator(machineId()), tracer })
  }),

  'text-service': async ({ client, tracer }) => ({
    Service: TextService,
    handler: new TextHandler({
      urlShorten: client(UrlShortenService, 'url-shorten-service'),
      userMention: client(UserMentionService, 'user-mention-service'),
      tracer
    })
  }),

  'media-service': async ({ tracer }) => ({
    Service: MediaService,
    handler: new MediaHandler({ tracer })
  }),

  'url-shorten-service': async ({ mongo, tracer }) => {
    const db = await mongo('url-shorten', 'url-shorten', 'url-shorten');
    return {
      Service: UrlShortenService,
      handler: new UrlShortenHandler({ collection: db.collection, tracer })
    };
  },

  'user-mention-service': async ({ cache, mongo, tracer }) => {
    const db = await mongo('user', 'user', 'user');
    return {
      Service: UserMentionService,
      handler: new UserMentionHandler({
        cache: cache('user'),
        collection: db.collection,
        tracer
      })
    };
  },

  'user-service': async ({ cache, client, mongo, tracer }) => {
    const db = await mongo('user', 'user', 'user');
    await uniqueIndex(db.collection, 'username');
    await uniqueIndex(db.collection, 'user_id');
    return {
      Service: UserService,
      handler: new UserHandler({
        cache: cache('user'),
        collection: db.collection,
        generator: new IdGenerator(machineId()),
        secret: config.secret,
        socialGraph: client(SocialGraphService, 'social-graph-service'),
        tracer
      })
    };
  },

  'social-graph-service': async ({ client, mongo, redis, tracer }) => {
    const db = await mongo('social-graph', 'social-graph', 'social-graph');
    await uniqueIndex(db.collection, 'user_id');
    return {
      Service: SocialGraphService,
      handler: new SocialGraphHandler({
        collection: db.collection,
        redis: await redis('social-graph'),
        userService: client(UserService, 'user-service'),
        tracer
      })
    };
  },

  'post-storage-service': async ({ cache, mongo, tracer }) => {
    const db = await mongo('post-storage', 'post', 'post');
    await uniqueIndex(db.collection, 'post_id');
    return {
      Service: PostStorageService,
      handler: new PostStorageHandler({
        cache: cache('post-storage'),
        collection: db.collection,
        tracer
      })
    };
  },

  'user-timeline-service': async ({ client, mongo, redis, tracer }) => {
    const db = await mongo('user-timeline', 'user-timeline', 'user-timeline');
    await uniqueIndex(db.collection, 'user_id');
    return {
      Service: UserTimelineService,
      handler: new UserTimelineHandler({
        collection: db.collection,
        postStorage: client(PostStorageService, 'post-storage-service'),
        redis: await redis('user-timeline'),
        tracer
      })
    };
  },

  'home-timeline-service': async ({ client, redis, tracer }) => ({
    Service: HomeTimelineService,
    handler: new HomeTimelineHandler({
      postStorage: client(PostStorageService, 'post-storage-service'),
      redis: await redis('home-timeline'),
      socialGraph: client(SocialGraphService, 'social-graph-service'),
      tracer
    })
  }),

  'compose-post-service': async ({ client, tracer }) => ({
    Service: ComposePostService,
    handler: new ComposePostHandler({
      homeTimeline: client(HomeTimelineService, 'home-timeline-service'),
      media: client(MediaService, 'media-service'),
      postStorage: client(PostStorageService, 'post-storage-service'),
      text: client(TextService, 'text-service'),
      uniqueId: client(UniqueIdService, 'unique-id-service'),
      user: client(UserService, 'user-service'),
      userTimeline: client(UserTimelineService, 'user-timeline-service'),
      tracer
    })
  })
};

async function start(serviceName) {
  if (!builders[serviceName]) {
    throw new Error(`Unknown social network service: ${serviceName}`);
  }
  await run(serviceName, builders[serviceName]);
}

module.exports = { start };
