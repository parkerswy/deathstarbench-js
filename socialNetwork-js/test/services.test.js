'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const jwt = require('jsonwebtoken');

const Types = require('../gen-nodejs/social_network_types');
const { IdGenerator } = require('../src/lib/idGenerator');
const { key, toBigInt, toWire, wirePost, wireUrl, wireUserMention } = require('../src/services/common');
const { ComposePostHandler, UniqueIdHandler } = require('../src/services/compose');
const { PostStorageHandler } = require('../src/services/postStorage');
const { SocialGraphHandler } = require('../src/services/socialGraph');
const { HomeTimelineHandler, UserTimelineHandler } = require('../src/services/timeline');
const { MediaHandler, TextHandler, UrlShortenHandler, UserMentionHandler } = require('../src/services/text');
const { UserHandler } = require('../src/services/user');
const {
  MemoryCache,
  MemoryCollection,
  MemoryRedis,
  recordingClient,
  toLong,
  tracer
} = require('./helpers');

test('ID generation matches original signed i64 layout', async () => {
  const generator = new IdGenerator('abc');
  const id = generator.next(1514764800001n);
  assert.equal(id, 0x2bc0000000001000n);

  const handler = new UniqueIdHandler({ generator, tracer });
  const wire = await handler.ComposeUniqueId(toWire(1n), Types.PostType.POST, {});
  assert.equal(typeof toBigInt(wire), 'bigint');
});

test('user registration inserts Mongo row, creates graph node, and login caches JWT input', async () => {
  const collection = new MemoryCollection();
  const socialGraph = recordingClient();
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection,
    generator: { next: () => 9007199254741001n },
    secret: 'secret',
    socialGraph,
    tracer
  });

  await handler.RegisterUser(toWire(1n), 'A', 'B', 'alice', 'pw', {});
  assert.equal(collection.rows[0].username, 'alice');
  assert.equal(socialGraph.calls[0][0], 'InsertUser');

  const first = await handler.Login(toWire(2n), 'alice', 'pw', {});
  const second = await handler.Login(toWire(3n), 'alice', 'pw', {});
  assert.equal(jwt.verify(first, 'secret').user_id, '9007199254741001');
  assert.equal(jwt.verify(second, 'secret').username, 'alice');
});

test('text, URL, and media handlers preserve original compose behavior', async () => {
  const urlCollection = new MemoryCollection();
  const urlHandler = new UrlShortenHandler({ collection: urlCollection, tracer });
  const urls = await urlHandler.ComposeUrls(toWire(1n), ['http://example'], {});
  assert.equal(urls[0].expanded_url, 'http://example');
  assert.match(urls[0].shortened_url, /^http:\/\/short-url\/[A-Za-z0-9]{10}$/);

  const textHandler = new TextHandler({
    urlShorten: recordingClient(async () => [wireUrl({
      expanded_url: 'http://example',
      shortened_url: 'http://short-url/abcdefghij'
    })]),
    userMention: recordingClient(async () => [wireUserMention({
      user_id: 7n,
      username: 'bob'
    })]),
    tracer
  });
  const composed = await textHandler.ComposeText(toWire(2n), 'hi @bob http://example suffix', {});
  assert.equal(composed.text, 'hi @bob http://short-url/abcdefghij');
  assert.equal(toBigInt(composed.user_mentions[0].user_id), 7n);

  const mediaHandler = new MediaHandler({ tracer });
  await assert.rejects(
    mediaHandler.ComposeMedia(toWire(3n), ['png'], [toWire(1n), toWire(2n)], {}),
    (error) => error instanceof Types.ServiceException
  );
});

test('compose post stores before fanout and carries mentions to home timeline', async () => {
  const calls = [];
  const client = (name, result) => ({
    async call(...args) {
      calls.push([name, ...args]);
      return typeof result === 'function' ? result(...args) : result;
    }
  });
  const handler = new ComposePostHandler({
    text: client('text', new Types.TextServiceReturn({
      text: 'hello',
      user_mentions: [wireUserMention({ user_id: 10n, username: 'bob' })],
      urls: []
    })),
    user: client('user', new Types.Creator({ user_id: toWire(1n), username: 'alice' })),
    media: client('media', []),
    uniqueId: client('uniqueId', toWire(99n)),
    postStorage: client('postStorage'),
    userTimeline: client('userTimeline'),
    homeTimeline: client('homeTimeline'),
    tracer
  });

  await handler.ComposePost(toWire(5n), 'alice', toWire(1n), 'hello', [], [], Types.PostType.POST, {});
  assert.equal(calls.findIndex((call) => call[0] === 'postStorage') <
    calls.findIndex((call) => call[0] === 'userTimeline'), true);
  const homeCall = calls.find((call) => call[0] === 'homeTimeline');
  assert.equal(toBigInt(homeCall[6][0]), 10n);
});

test('post storage orders cache and Mongo reads by requested IDs', async () => {
  const handler = new PostStorageHandler({
    cache: new MemoryCache(),
    collection: new MemoryCollection(),
    tracer
  });
  const postA = wirePost({
    post_id: 1n,
    creator: { user_id: 1n, username: 'alice' },
    req_id: 1n,
    text: 'a',
    user_mentions: [],
    media: [],
    urls: [],
    timestamp: 10n,
    post_type: Types.PostType.POST
  });
  const postB = wirePost({
    post_id: 2n,
    creator: { user_id: 1n, username: 'alice' },
    req_id: 2n,
    text: 'b',
    user_mentions: [],
    media: [],
    urls: [],
    timestamp: 20n,
    post_type: Types.PostType.POST
  });

  await handler.StorePost(toWire(1n), postA, {});
  await handler.StorePost(toWire(2n), postB, {});
  const result = await handler.ReadPosts(toWire(3n), [toWire(2n), toWire(1n)], {});
  assert.deepEqual(result.map((post) => post.text), ['b', 'a']);
});

test('social graph follow/unfollow keeps Mongo and Redis in sync', async () => {
  const redis = new MemoryRedis();
  const collection = new MemoryCollection([
    { user_id: toLong(1n), followers: [], followees: [] },
    { user_id: toLong(2n), followers: [], followees: [] }
  ]);
  const handler = new SocialGraphHandler({
    collection,
    redis,
    userService: recordingClient(),
    tracer
  });

  await handler.Follow(toWire(1n), toWire(1n), toWire(2n), {});
  assert.deepEqual((await handler.GetFollowees(toWire(2n), toWire(1n), {})).map(toBigInt), [2n]);
  assert.deepEqual((await handler.GetFollowers(toWire(3n), toWire(2n), {})).map(toBigInt), [1n]);

  await handler.Unfollow(toWire(4n), toWire(1n), toWire(2n), {});
  assert.deepEqual(await redis.zRange('1:followees', 0, -1), []);
});

test('timeline handlers write sorted IDs and read through post storage', async () => {
  const redis = new MemoryRedis();
  const postStorage = recordingClient(async () => []);
  const userTimeline = new UserTimelineHandler({
    collection: new MemoryCollection(),
    postStorage,
    redis,
    tracer
  });

  await userTimeline.WriteUserTimeline(toWire(1n), toWire(11n), toWire(7n), toWire(100n), {});
  await userTimeline.WriteUserTimeline(toWire(2n), toWire(12n), toWire(7n), toWire(200n), {});
  await userTimeline.ReadUserTimeline(toWire(3n), toWire(7n), 0, 2, {});
  assert.deepEqual(postStorage.calls[0][2].map(toBigInt), [12n, 11n]);

  const redisV4Only = {
    zAdd: redis.zAdd.bind(redis),
    zRange: redis.zRange.bind(redis)
  };
  const postStorageV4 = recordingClient(async () => []);
  const userTimelineV4 = new UserTimelineHandler({
    collection: new MemoryCollection(),
    postStorage: postStorageV4,
    redis: redisV4Only,
    tracer
  });
  await userTimelineV4.ReadUserTimeline(toWire(3n), toWire(7n), 0, 2, {});
  assert.deepEqual(postStorageV4.calls[0][2].map(toBigInt), [12n, 11n]);

  const homeTimeline = new HomeTimelineHandler({
    postStorage,
    redis,
    socialGraph: recordingClient(async () => [toWire(8n)]),
    tracer
  });
  await homeTimeline.WriteHomeTimeline(toWire(4n), toWire(99n), toWire(7n), toWire(300n), [toWire(9n)], {});
  assert.deepEqual(await redis.zRevRange('8', 0, -1), ['99']);
  assert.deepEqual(await redis.zRevRange('9', 0, -1), ['99']);
});

// ---------------------------------------------------------------------------
// Static work-spec parity (Method 1): pin each handler's datastore/RPC contract
// to the field names, cache/Redis key formats, hashing, JWT claims, and call
// fan-out used by the original C++ services in ../../socialNetwork/src. These
// assertions fail if the JS port issues a *different* storage/call operation
// than the C++ original for the same input. C++ line refs in comments.
// ---------------------------------------------------------------------------

const sortedKeys = (obj) => Object.keys(obj).sort();

function serviceException(code, message) {
  return (error) => {
    assert.equal(error instanceof Types.ServiceException, true);
    assert.equal(error.errorCode, Types.ErrorCode[code]);
    assert.equal(error.message, message);
    return true;
  };
}

function postFixture(postId, postText = `post_${postId}`) {
  return wirePost({
    post_id: BigInt(postId),
    creator: { user_id: 7n, username: 'alice' },
    req_id: 1n,
    text: postText,
    user_mentions: [],
    media: [],
    urls: [],
    timestamp: 100n + BigInt(postId),
    post_type: Types.PostType.POST
  });
}

class RecordingRedis extends MemoryRedis {
  constructor() {
    super();
    this.zAddCalls = [];
  }

  async zAdd(name, members, options = {}) {
    const list = Array.isArray(members) ? members : [members];
    this.zAddCalls.push({
      name,
      members: list.map((member) => ({ score: member.score, value: member.value })),
      options: { ...options }
    });
    return super.zAdd(name, members, options);
  }
}

test('user document field set, salt format, and password hash match C++ schema', async () => {
  const collection = new MemoryCollection();
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection,
    generator: { next: () => 9007199254741001n },
    secret: 'secret',
    socialGraph: recordingClient(),
    tracer
  });
  await handler.RegisterUser(toWire(1n), 'A', 'B', 'alice', 'pw', {});
  const doc = collection.rows[0];

  // C++ BSON_APPEND fields (UserHandler.h:322-329): no renamed/extra fields.
  assert.deepEqual(sortedKeys(doc),
    ['first_name', 'last_name', 'password', 'salt', 'user_id', 'username']);
  // C++ salt = GenRandomString(32) over [0-9A-Za-z] (UserHandler.h:178, utils 54-58).
  assert.match(doc.salt, /^[0-9A-Za-z]{32}$/);
  // C++ password = picosha2::hash256_hex_string(password + salt) (UserHandler.h:180).
  assert.equal(doc.password, crypto.createHash('sha256').update('pw' + doc.salt).digest('hex'));
});

test('user service caches under <username>:user_id and <username>:login keys', async () => {
  const cache = new MemoryCache();
  const handler = new UserHandler({
    cache,
    collection: new MemoryCollection(),
    generator: { next: () => 42n },
    secret: 'secret',
    socialGraph: recordingClient(),
    tracer
  });
  await handler.RegisterUser(toWire(1n), 'A', 'B', 'alice', 'pw', {});

  await handler.GetUserId(toWire(2n), 'alice', {});
  // C++ memcached key = username + ":user_id", value = decimal user_id (UserHandler.h:520-521).
  assert.equal(cache.values.get('alice:user_id'), '42');

  await handler.Login(toWire(3n), 'alice', 'pw', {});
  // C++ memcached key = username + ":login", JSON {password,salt,user_id} (UserHandler.h:735, 604-606).
  assert.ok(cache.values.has('alice:login'));
  assert.deepEqual(sortedKeys(JSON.parse(cache.values.get('alice:login'))),
    ['password', 'salt', 'user_id']);
});

test('login JWT carries exactly user_id/username/timestamp/ttl and no iat', async () => {
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection: new MemoryCollection(),
    generator: { next: () => 9007199254741001n },
    secret: 'secret',
    socialGraph: recordingClient(),
    tracer
  });
  await handler.RegisterUser(toWire(1n), 'A', 'B', 'alice', 'pw', {});
  const decoded = jwt.verify(await handler.Login(toWire(2n), 'alice', 'pw', {}), 'secret');

  // C++ payload({user_id,username,timestamp,ttl}), HS256, no iat (UserHandler.h:706-710).
  assert.deepEqual(sortedKeys(decoded), ['timestamp', 'ttl', 'user_id', 'username']);
  assert.equal(decoded.ttl, '3600');
  assert.equal(decoded.user_id, '9007199254741001'); // string, not number
  assert.equal(decoded.iat, undefined);
});

test('user id and login lookups use warmed cache before Mongo', async () => {
  const collection = new MemoryCollection();
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection,
    generator: { next: () => 7n },
    secret: 'secret',
    socialGraph: recordingClient(),
    tracer
  });

  await handler.RegisterUser(toWire(1n), 'A', 'B', 'alice', 'pw', {});
  assert.equal(toBigInt(await handler.GetUserId(toWire(2n), 'alice', {})), 7n);
  assert.equal(jwt.verify(await handler.Login(toWire(3n), 'alice', 'pw', {}), 'secret').user_id, '7');

  collection.rows = [];
  assert.equal(toBigInt(await handler.GetUserId(toWire(4n), 'alice', {})), 7n);
  assert.equal(jwt.verify(await handler.Login(toWire(5n), 'alice', 'pw', {}), 'secret').username, 'alice');
});

test('user service negative paths return C++-compatible ServiceExceptions', async () => {
  const socialGraph = recordingClient();
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection: new MemoryCollection(),
    generator: { next: () => 42n },
    secret: 'secret',
    socialGraph,
    tracer
  });

  await handler.RegisterUser(toWire(1n), 'A', 'B', 'alice', 'pw', {});
  await assert.rejects(
    handler.RegisterUserWithId(toWire(2n), 'A', 'B', 'alice', 'pw', toWire(43n), {}),
    serviceException('SE_THRIFT_HANDLER_ERROR', 'User alice already existed')
  );
  assert.equal(socialGraph.calls.length, 1, 'duplicate registration must not insert another graph node');

  await assert.rejects(
    handler.Login(toWire(3n), 'alice', 'wrong', {}),
    serviceException('SE_UNAUTHORIZED', 'Incorrect username or password')
  );
  await assert.rejects(
    handler.Login(toWire(4n), 'missing', 'pw', {}),
    serviceException('SE_UNAUTHORIZED', 'User: missing is not registered')
  );
  await assert.rejects(
    handler.GetUserId(toWire(5n), 'missing', {}),
    serviceException('SE_THRIFT_HANDLER_ERROR', 'User: missing is not registered')
  );

  const incompleteLogin = new UserHandler({
    cache: new MemoryCache(),
    collection: new MemoryCollection([{ username: 'broken', user_id: toLong(77n), password: 'hash' }]),
    generator: { next: () => 77n },
    secret: 'secret',
    socialGraph: recordingClient(),
    tracer
  });
  await assert.rejects(
    incompleteLogin.Login(toWire(6n), 'broken', 'pw', {}),
    serviceException('SE_THRIFT_HANDLER_ERROR', 'user: broken entry is NOT complete')
  );

  const incompleteLookup = new UserHandler({
    cache: new MemoryCache(),
    collection: new MemoryCollection([{ username: 'noid' }]),
    generator: { next: () => 78n },
    secret: 'secret',
    socialGraph: recordingClient(),
    tracer
  });
  await assert.rejects(
    incompleteLookup.GetUserId(toWire(7n), 'noid', {}),
    serviceException(
      'SE_THRIFT_HANDLER_ERROR',
      'user_id attribute of user: noid was not found in the User object'
    )
  );
});

test('post storage document and cache key match C++ BSON/memcached layout', async () => {
  const cache = new MemoryCache();
  const collection = new MemoryCollection();
  const handler = new PostStorageHandler({ cache, collection, tracer });
  const post = wirePost({
    post_id: 5n,
    creator: { user_id: 7n, username: 'alice' },
    req_id: 1n,
    text: 'hi',
    user_mentions: [{ user_id: 9n, username: 'bob' }],
    media: [{ media_id: 3n, media_type: 'png' }],
    urls: [{ shortened_url: 's', expanded_url: 'e' }],
    timestamp: 100n,
    post_type: Types.PostType.POST
  });
  await handler.StorePost(toWire(1n), post, {});
  const doc = collection.rows[0];

  // C++ BSON_APPEND fields (PostStorageHandler.h:80-132).
  assert.deepEqual(sortedKeys(doc),
    ['creator', 'media', 'post_id', 'post_type', 'req_id', 'text', 'timestamp', 'urls', 'user_mentions']);
  assert.deepEqual(sortedKeys(doc.creator), ['user_id', 'username']);
  assert.deepEqual(sortedKeys(doc.urls[0]), ['expanded_url', 'shortened_url']);
  assert.deepEqual(sortedKeys(doc.user_mentions[0]), ['user_id', 'username']);
  assert.deepEqual(sortedKeys(doc.media[0]), ['media_id', 'media_type']);

  await handler.ReadPost(toWire(2n), toWire(5n), {}); // cache miss -> backfills
  // C++ memcached key = std::to_string(post_id) (PostStorageHandler.h:176, 337).
  assert.ok(cache.values.has('5'));
});

test('post storage empty multi-read returns [] without touching cache or Mongo', async () => {
  const cache = new MemoryCache();
  const collection = new MemoryCollection();
  cache.getMulti = async () => {
    throw new Error('unexpected cache read');
  };
  collection.find = () => {
    throw new Error('unexpected Mongo read');
  };
  const handler = new PostStorageHandler({ cache, collection, tracer });

  assert.deepEqual(await handler.ReadPosts(toWire(1n), [], {}), []);
});

test('post storage rejects duplicate and incomplete reads like C++', async () => {
  const handler = new PostStorageHandler({
    cache: new MemoryCache(),
    collection: new MemoryCollection(),
    tracer
  });

  await assert.rejects(
    handler.ReadPost(toWire(1n), toWire(5n), {}),
    serviceException('SE_THRIFT_HANDLER_ERROR', "Post_id: 5 doesn't exist in MongoDB")
  );
  await assert.rejects(
    handler.ReadPosts(toWire(2n), [toWire(1n), toWire(1n)], {}),
    serviceException('SE_THRIFT_HANDLER_ERROR', 'Post_ids are duplicated')
  );

  await handler.StorePost(toWire(3n), postFixture(1n, 'stored'), {});
  await assert.rejects(
    handler.ReadPosts(toWire(4n), [toWire(1n), toWire(2n)], {}),
    serviceException('SE_THRIFT_HANDLER_ERROR', 'Return set incomplete')
  );
});

test('post storage cache hits preserve requested order without consulting mutated Mongo rows', async () => {
  const cache = new MemoryCache();
  const collection = new MemoryCollection();
  const handler = new PostStorageHandler({ cache, collection, tracer });

  await handler.StorePost(toWire(1n), postFixture(1n, 'from-cache'), {});
  assert.equal((await handler.ReadPost(toWire(2n), toWire(1n), {})).text, 'from-cache');

  collection.rows[0].text = 'mutated-mongo';
  const cached = await handler.ReadPosts(toWire(3n), [toWire(1n)], {});
  assert.deepEqual(cached.map((post) => post.text), ['from-cache']);
});

test('post storage mixed cache and Mongo reads preserve requested ordering', async () => {
  const cache = new MemoryCache();
  const collection = new MemoryCollection();
  const handler = new PostStorageHandler({ cache, collection, tracer });

  await handler.StorePost(toWire(1n), postFixture(1n, 'cached-one'), {});
  await handler.StorePost(toWire(2n), postFixture(2n, 'mongo-two'), {});
  assert.equal((await handler.ReadPost(toWire(3n), toWire(1n), {})).text, 'cached-one');

  collection.rows.find((row) => key(row.post_id) === '1').text = 'mutated-one';
  const mixed = await handler.ReadPosts(toWire(4n), [toWire(2n), toWire(1n)], {});
  assert.deepEqual(mixed.map((post) => post.text), ['mongo-two', 'cached-one']);
});

test('social graph document fields, edge shape, and both redis keys match C++', async () => {
  const collection = new MemoryCollection();
  const redis = new MemoryRedis();
  const handler = new SocialGraphHandler({ collection, redis, userService: recordingClient(), tracer });

  await handler.InsertUser(toWire(1n), toWire(10n), {});
  await handler.InsertUser(toWire(1n), toWire(20n), {});
  // C++ social-graph doc {user_id, followers[], followees[]}.
  assert.deepEqual(sortedKeys(collection.rows[0]), ['followees', 'followers', 'user_id']);

  await handler.Follow(toWire(1n), toWire(10n), toWire(20n), {});
  // C++ zadd(to_string(user_id)+":followees") and zadd(to_string(followee_id)+":followers") (SocialGraphHandler.h:241-243).
  assert.ok(redis.zsets.has('10:followees'));
  assert.ok(redis.zsets.has('20:followers'));
  // C++ $push {user_id, timestamp} into the edge array (SocialGraphHandler.h:145).
  const edge = collection.rows.find((row) => key(row.user_id) === '10').followees[0];
  assert.deepEqual(sortedKeys(edge), ['timestamp', 'user_id']);
});

test('social graph missing-user and duplicate-edge paths match C++', async () => {
  const empty = new SocialGraphHandler({
    collection: new MemoryCollection(),
    redis: new MemoryRedis(),
    userService: recordingClient(),
    tracer
  });
  assert.deepEqual(await empty.GetFollowers(toWire(1n), toWire(404n), {}), []);
  await assert.rejects(
    empty.GetFollowees(toWire(2n), toWire(404n), {}),
    serviceException('SE_THRIFT_HANDLER_ERROR', 'Cannot find user_id in MongoDB.')
  );

  const redis = new MemoryRedis();
  const collection = new MemoryCollection([
    { user_id: toLong(1n), followers: [], followees: [] },
    { user_id: toLong(2n), followers: [], followees: [] }
  ]);
  const handler = new SocialGraphHandler({
    collection,
    redis,
    userService: recordingClient(),
    tracer
  });

  await handler.Follow(toWire(3n), toWire(1n), toWire(2n), {});
  await handler.Follow(toWire(4n), toWire(1n), toWire(2n), {});

  const user = collection.rows.find((row) => key(row.user_id) === '1');
  const followee = collection.rows.find((row) => key(row.user_id) === '2');
  assert.equal(user.followees.length, 1);
  assert.equal(followee.followers.length, 1);
  assert.deepEqual(await redis.zRange('1:followees', 0, -1), ['2']);
  assert.deepEqual(await redis.zRange('2:followers', 0, -1), ['1']);

  await handler.Unfollow(toWire(5n), toWire(1n), toWire(2n), {});
  await handler.Unfollow(toWire(6n), toWire(1n), toWire(2n), {});
  assert.deepEqual(user.followees, []);
  assert.deepEqual(followee.followers, []);
  assert.deepEqual(await redis.zRange('1:followees', 0, -1), []);
});

test('GetFollowees backfills Redis from Mongo on a cold-cache read', async () => {
  const redis = new MemoryRedis();
  const collection = new MemoryCollection([{
    user_id: toLong(5n),
    followers: [],
    followees: [{ user_id: toLong(9n), timestamp: toLong(100n) }]
  }]);
  const handler = new SocialGraphHandler({ collection, redis, userService: recordingClient(), tracer });

  const followees = await handler.GetFollowees(toWire(1n), toWire(5n), {});
  assert.deepEqual(followees.map(toBigInt), [9n]);
  assert.deepEqual(await redis.zRange('5:followees', 0, -1), ['9']);
});

test('user timeline document stores posts array of {post_id,timestamp} under bare user_id key', async () => {
  const collection = new MemoryCollection();
  const redis = new MemoryRedis();
  const handler = new UserTimelineHandler({ collection, postStorage: recordingClient(), redis, tracer });

  await handler.WriteUserTimeline(toWire(1n), toWire(5n), toWire(77n), toWire(100n), {});
  // C++ $push into "posts" array of {post_id, timestamp} (UserTimelineHandler.h:123).
  assert.ok(Array.isArray(collection.rows[0].posts));
  assert.deepEqual(sortedKeys(collection.rows[0].posts[0]), ['post_id', 'timestamp']);
  // C++ redis zadd(std::to_string(user_id)) — bare key, no suffix (UserTimelineHandler.h:168).
  assert.ok(redis.zsets.has('77'));
});

test('user mention service caches under <username>:user_id key', async () => {
  const cache = new MemoryCache();
  const collection = new MemoryCollection([{ username: 'bob', user_id: toLong(9n) }]);
  const handler = new UserMentionHandler({ cache, collection, tracer });

  await handler.ComposeUserMentions(toWire(1n), ['bob'], {});
  // C++ memcached key = username + ":user_id" (UserMentionHandler.h).
  assert.equal(cache.values.get('bob:user_id'), '9');
});

test('timeline reads handle invalid ranges and mixed Redis/Mongo windows like C++', async () => {
  const userPostStorage = recordingClient(async () => []);
  const userTimeline = new UserTimelineHandler({
    collection: new MemoryCollection(),
    postStorage: userPostStorage,
    redis: new MemoryRedis(),
    tracer
  });
  assert.deepEqual(await userTimeline.ReadUserTimeline(toWire(1n), toWire(7n), 1, 1, {}), []);
  assert.deepEqual(await userTimeline.ReadUserTimeline(toWire(2n), toWire(7n), -1, 2, {}), []);
  assert.equal(userPostStorage.calls.length, 0);

  const homePostStorage = recordingClient(async () => []);
  const homeTimeline = new HomeTimelineHandler({
    postStorage: homePostStorage,
    redis: new MemoryRedis(),
    socialGraph: recordingClient(async () => []),
    tracer
  });
  assert.deepEqual(await homeTimeline.ReadHomeTimeline(toWire(3n), toWire(7n), 2, 2, {}), []);
  assert.deepEqual(await homeTimeline.ReadHomeTimeline(toWire(4n), toWire(7n), -1, 2, {}), []);
  assert.equal(homePostStorage.calls.length, 0);

  const redis = new MemoryRedis();
  await redis.zAdd('7', [{ score: 200, value: '12' }]);
  const mixedPostStorage = recordingClient(async () => []);
  const mixedTimeline = new UserTimelineHandler({
    collection: new MemoryCollection([{
      user_id: toLong(7n),
      posts: [
        { post_id: toLong(12n), timestamp: toLong(200n) },
        { post_id: toLong(11n), timestamp: toLong(100n) }
      ]
    }]),
    postStorage: mixedPostStorage,
    redis,
    tracer
  });
  await mixedTimeline.ReadUserTimeline(toWire(5n), toWire(7n), 0, 2, {});
  assert.deepEqual(mixedPostStorage.calls[0][2].map(toBigInt), [12n, 11n]);
});

test('home timeline reads Redis IDs in reverse score order through post storage', async () => {
  const redis = new MemoryRedis();
  await redis.zAdd('7', [
    { score: 100, value: '11' },
    { score: 200, value: '12' }
  ]);
  const postStorage = recordingClient(async () => []);
  const handler = new HomeTimelineHandler({
    postStorage,
    redis,
    socialGraph: recordingClient(async () => []),
    tracer
  });

  await handler.ReadHomeTimeline(toWire(1n), toWire(7n), 0, 2, {});
  assert.deepEqual(postStorage.calls[0][2].map(toBigInt), [12n, 11n]);
});

test('home timeline write deduplicates follower and mention targets before Redis writes', async () => {
  const redis = new RecordingRedis();
  const handler = new HomeTimelineHandler({
    postStorage: recordingClient(),
    redis,
    socialGraph: recordingClient(async () => [toWire(8n), toWire(9n)]),
    tracer
  });

  await handler.WriteHomeTimeline(
    toWire(1n),
    toWire(99n),
    toWire(7n),
    toWire(300n),
    [toWire(9n), toWire(10n), toWire(8n), toWire(10n)],
    {}
  );

  assert.deepEqual(redis.zAddCalls.map((call) => call.name).sort(), ['10', '8', '9']);
  assert.equal(redis.zAddCalls.length, 3);
  for (const call of redis.zAddCalls) {
    assert.deepEqual(call.members, [{ score: 300, value: '99' }]);
    assert.deepEqual(call.options, { NX: true });
  }
});

test('text and mention edge cases preserve original parsing behavior', async () => {
  const cache = new MemoryCache();
  const mentions = new UserMentionHandler({
    cache,
    collection: new MemoryCollection([{ username: 'bob', user_id: toLong(9n) }]),
    tracer
  });
  const result = await mentions.ComposeUserMentions(toWire(1n), ['bob', 'missing', 'bob'], {});
  assert.deepEqual(result.map((mention) => mention.username), ['bob']);
  assert.equal(cache.values.get('bob:user_id'), '9');

  const noUrlText = new TextHandler({
    urlShorten: recordingClient(async () => []),
    userMention: recordingClient(async () => []),
    tracer
  });
  const plain = await noUrlText.ComposeText(toWire(2n), 'plain text only', {});
  assert.equal(plain.text, 'plain text only');

  const urlText = new TextHandler({
    urlShorten: recordingClient(async () => [
      wireUrl({ expanded_url: 'http://one', shortened_url: 'http://short-url/aaaaaaaaaa' }),
      wireUrl({ expanded_url: 'https://two', shortened_url: 'http://short-url/bbbbbbbbbb' })
    ]),
    userMention: recordingClient(async () => []),
    tracer
  });
  const composed = await urlText.ComposeText(
    toWire(3n),
    'prefix http://one middle https://two trailing',
    {}
  );
  // C++ TextHandler reconstructs only through the last URL match and drops the suffix.
  assert.equal(composed.text, 'prefix http://short-url/aaaaaaaaaa middle http://short-url/bbbbbbbbbb');
});

test('compose post fans out to all upstreams and orders storage before both timelines', async () => {
  const order = [];
  const client = () => ({
    async call(method, ...rest) {
      order.push(method);
      if (method === 'ComposeText') {
        return new Types.TextServiceReturn({ text: 'hi', user_mentions: [], urls: [] });
      }
      if (method === 'ComposeCreatorWithUserId') {
        return new Types.Creator({ user_id: rest[1], username: 'alice' });
      }
      if (method === 'ComposeMedia') return [];
      if (method === 'ComposeUniqueId') return toWire(5n);
      return undefined;
    }
  });
  const handler = new ComposePostHandler({
    text: client(), user: client(), media: client(), uniqueId: client(),
    postStorage: client(), userTimeline: client(), homeTimeline: client(), tracer
  });
  await handler.ComposePost(toWire(1n), 'alice', toWire(7n), 'hi', [], [], Types.PostType.POST, {});

  const idx = (method) => order.indexOf(method);
  // C++ ComposePostHandler fans out to text/creator/media/unique-id before assembling.
  for (const method of ['ComposeText', 'ComposeCreatorWithUserId', 'ComposeMedia', 'ComposeUniqueId']) {
    assert.ok(idx(method) >= 0, `missing fan-out call: ${method}`);
  }
  // C++ order: StorePost (282) -> WriteUserTimeline (315) -> WriteHomeTimeline (349).
  assert.ok(idx('StorePost') < idx('WriteUserTimeline'));
  assert.ok(idx('WriteUserTimeline') < idx('WriteHomeTimeline'));
});

test('compose post timestamp is milliseconds since epoch, not seconds', async () => {
  // The differential test masks the timestamp value (wall clock), so its UNIT
  // is not checked there. C++ uses duration_cast<milliseconds> and passes that
  // to StorePost/WriteUserTimeline/WriteHomeTimeline (ComposePostHandler.h:388-390).
  // Pin the unit here: a seconds clock (~1.7e9, 10 digits) fails; ms (~1.7e12) passes.
  const text = recordingClient(async () =>
    new Types.TextServiceReturn({ text: 'hi', user_mentions: [], urls: [] }));
  const user = recordingClient(async (_method, _reqId, userId) =>
    new Types.Creator({ user_id: userId, username: 'alice' }));
  const media = recordingClient(async () => []);
  const uniqueId = recordingClient(async () => toWire(5n));
  const postStorage = recordingClient();
  const userTimeline = recordingClient();
  const homeTimeline = recordingClient();

  const handler = new ComposePostHandler({
    text, user, media, uniqueId, postStorage, userTimeline, homeTimeline, tracer
  });
  await handler.ComposePost(toWire(1n), 'alice', toWire(7n), 'hi', [], [], Types.PostType.POST, {});

  const MS_2020 = 1_600_000_000_000n; // a seconds clock (~1.7e9) is far below this floor
  const MS_2100 = 4_102_444_800_000n;
  const inMsRange = (v) => v > MS_2020 && v < MS_2100;

  const storedTs = toBigInt(postStorage.calls[0][2].timestamp); // StorePost(post).timestamp
  const userTimelineTs = toBigInt(userTimeline.calls[0][4]);     // WriteUserTimeline(..., timestamp, ...)
  assert.ok(inMsRange(storedTs), `stored timestamp is not milliseconds: ${storedTs}`);
  assert.ok(inMsRange(userTimelineTs), `user-timeline timestamp is not milliseconds: ${userTimelineTs}`);
  assert.equal(storedTs, userTimelineTs); // one instant reused for the post and the timeline write
});

// ---------------------------------------------------------------------------
// Additional uncovered paths: deterministic-id registration, the username-based
// follow endpoints actually used by init_social_graph, the Redis-cold edge-list
// backfill, URL persistence, media happy path, and the GetExtendedUrls stub.
// ---------------------------------------------------------------------------

test('RegisterUserWithId stores the provided user_id, not the generator (differential determinism)', async () => {
  const collection = new MemoryCollection();
  const socialGraph = recordingClient();
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection,
    generator: { next: () => 999n }, // must NOT be consulted
    secret: 'secret',
    socialGraph,
    tracer
  });
  await handler.RegisterUserWithId(toWire(1n), 'A', 'B', 'carol', 'pw', toWire(43n), {});

  // C++ RegisterUserWithId persists the supplied id (UserHandler.h:117-174). This is
  // what makes user_ids identical across both stacks, which the differential relies on.
  assert.equal(toBigInt(collection.rows[0].user_id), 43n);
  assert.equal(socialGraph.calls[0][0], 'InsertUser');
  assert.equal(toBigInt(socialGraph.calls[0][2]), 43n); // graph node uses the same provided id
});

test('FollowWithUsername/UnfollowWithUsername resolve via user-service then mutate the graph', async () => {
  const ids = { alice: 1n, bob: 2n };
  const userService = recordingClient(async (_method, _reqId, username) => toWire(ids[username]));
  const redis = new MemoryRedis();
  const collection = new MemoryCollection([
    { user_id: toLong(1n), followers: [], followees: [] },
    { user_id: toLong(2n), followers: [], followees: [] }
  ]);
  const handler = new SocialGraphHandler({ collection, redis, userService, tracer });

  // This is the path POST /wrk2-api/user/follow actually drives.
  await handler.FollowWithUsername(toWire(1n), 'alice', 'bob', {});
  assert.equal(userService.calls.length, 2);
  assert.ok(userService.calls.every((c) => c[0] === 'GetUserId'));
  assert.deepEqual(new Set(userService.calls.map((c) => c[2])), new Set(['alice', 'bob']));
  assert.deepEqual(await redis.zRange('1:followees', 0, -1), ['2']);
  assert.deepEqual(await redis.zRange('2:followers', 0, -1), ['1']);

  await handler.UnfollowWithUsername(toWire(2n), 'alice', 'bob', {});
  assert.deepEqual(await redis.zRange('1:followees', 0, -1), []);
  assert.deepEqual(collection.rows.find((r) => key(r.user_id) === '1').followees, []);
});

test('GetFollowers backfills Redis from Mongo on a cold-cache read', async () => {
  const redis = new MemoryRedis(); // intentionally cold
  const collection = new MemoryCollection([{
    user_id: toLong(5n),
    followers: [{ user_id: toLong(9n), timestamp: toLong(100n) }],
    followees: []
  }]);
  const handler = new SocialGraphHandler({ collection, redis, userService: recordingClient(), tracer });

  const followers = await handler.GetFollowers(toWire(1n), toWire(5n), {});
  assert.deepEqual(followers.map(toBigInt), [9n]);
  // C++ readEdgeList warms the sorted set from Mongo when Redis is empty — cache behavior
  // that affects latency, so worth pinning (SocialGraphHandler.h GetFollowers/readEdgeList).
  assert.deepEqual(await redis.zRange('5:followers', 0, -1), ['9']);
});

test('UrlShorten persists {expanded_url,shortened_url} docs and no-ops on empty input', async () => {
  const collection = new MemoryCollection();
  const handler = new UrlShortenHandler({ collection, tracer });

  const urls = await handler.ComposeUrls(toWire(1n), ['http://a', 'http://b'], {});
  assert.equal(urls.length, 2);
  assert.equal(collection.rows.length, 2);
  assert.deepEqual(sortedKeys(collection.rows[0]), ['expanded_url', 'shortened_url']);
  assert.equal(collection.rows[0].expanded_url, 'http://a');
  assert.match(collection.rows[0].shortened_url, /^http:\/\/short-url\/[A-Za-z0-9]{10}$/);

  await handler.ComposeUrls(toWire(2n), [], {});
  assert.equal(collection.rows.length, 2, 'empty input must not insert');
});

test('MediaService composes a media list preserving order, ids, and types', async () => {
  const handler = new MediaHandler({ tracer });
  const media = await handler.ComposeMedia(toWire(1n), ['png', 'gif'], [toWire(3n), toWire(4n)], {});
  assert.deepEqual(media.map((m) => [toBigInt(m.media_id), m.media_type]), [[3n, 'png'], [4n, 'gif']]);
  assert.deepEqual(await handler.ComposeMedia(toWire(2n), [], [], {}), []);
});

test('ComposeCreatorWithUsername resolves the user_id via lookup', async () => {
  const handler = new UserHandler({
    cache: new MemoryCache(),
    collection: new MemoryCollection([{ username: 'alice', user_id: toLong(7n) }]),
    generator: { next: () => 0n },
    secret: 'secret',
    socialGraph: recordingClient(),
    tracer
  });
  const creator = await handler.ComposeCreatorWithUsername(toWire(1n), 'alice', {});
  assert.equal(toBigInt(creator.user_id), 7n);
  assert.equal(creator.username, 'alice');
});

test('GetExtendedUrls is a no-op returning [] (matches the C++ TODO stub)', async () => {
  const handler = new UrlShortenHandler({ collection: new MemoryCollection(), tracer });
  // C++ UrlShortenHandler::GetExtendedUrls is unimplemented and returns empty; JS matches.
  // Pinned so a future "implementation" on one side can't silently diverge from the other.
  assert.deepEqual(await handler.GetExtendedUrls(toWire(1n), ['http://short-url/x'], {}), []);
});

// ---------------------------------------------------------------------------
// Value-domain coverage: the handler control-flow is saturated above; these pin
// fidelity across the value ranges a JS port is most likely to corrupt — 64-bit
// ids beyond 2^53 through the cache/Mongo serialization paths, text-parsing
// parity with the C++ regexes, and non-POST post_type enum values.
// ---------------------------------------------------------------------------

test('large i64 ids survive both the Mongo and cache round-trips (>2^53)', async () => {
  const cache = new MemoryCache();
  const collection = new MemoryCollection();
  const handler = new PostStorageHandler({ cache, collection, tracer });
  const bigPostId = 9223372036854775807n;       // max signed i64
  const bigUserId = 9007199254740993n;          // 2^53 + 1 (first unsafe JS number)
  await handler.StorePost(toWire(1n), wirePost({
    post_id: bigPostId,
    creator: { user_id: bigUserId, username: 'alice' },
    req_id: 1n,
    text: 'big',
    user_mentions: [],
    media: [],
    urls: [],
    timestamp: 1_780_000_000_000n,
    post_type: Types.PostType.POST
  }), {});

  // First read: cache miss -> Mongo path (Long), then backfills the cache.
  const fromMongo = await handler.ReadPost(toWire(2n), toWire(bigPostId), {});
  assert.equal(toBigInt(fromMongo.post_id), bigPostId);
  assert.equal(toBigInt(fromMongo.creator.user_id), bigUserId);

  // Second read: cache hit -> JSON path (decimal-string round-trip, not a JS number).
  const fromCache = await handler.ReadPost(toWire(3n), toWire(bigPostId), {});
  assert.equal(toBigInt(fromCache.post_id), bigPostId);
  assert.equal(toBigInt(fromCache.creator.user_id), bigUserId);
  assert.ok(cache.values.has('9223372036854775807'), 'cache key must be the full decimal id');
});

test('text parsing matches C++ regex semantics on tricky inputs', async () => {
  // JS regexes mirror the C++ TextHandler.h:55,65 behavior for mentions/URLs.
  // Lock the extracted mention list so an edit can't silently diverge from C++:
  // an email yields a mention, trailing punctuation is excluded, underscores/digits kept,
  // and dedup happens downstream in UserMention (so duplicates pass through here).
  const captured = [];
  const textHandler = new TextHandler({
    urlShorten: recordingClient(async () => []),
    userMention: recordingClient(async (_method, _reqId, usernames) => {
      captured.push(usernames);
      return [];
    }),
    tracer
  });
  await textHandler.ComposeText(toWire(1n), 'mail a@bob.com ping @carol! and @dave_99 plus @carol', {});
  assert.deepEqual(captured[0], ['bob', 'carol', 'dave_99', 'carol']);
});

test('non-POST post_type enum values round-trip through storage', async () => {
  const handler = new PostStorageHandler({
    cache: new MemoryCache(),
    collection: new MemoryCollection(),
    tracer
  });
  for (const postType of [Types.PostType.REPOST, Types.PostType.REPLY, Types.PostType.DM]) {
    const id = BigInt(100 + postType);
    await handler.StorePost(toWire(1n), wirePost({
      post_id: id,
      creator: { user_id: 7n, username: 'a' },
      req_id: 1n,
      text: 't',
      user_mentions: [],
      media: [],
      urls: [],
      timestamp: 1_780_000_000_000n,
      post_type: postType
    }), {});
    const read = await handler.ReadPost(toWire(2n), toWire(id), {});
    assert.equal(read.post_type, postType);
  }
});
