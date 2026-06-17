'use strict';

const { key, nowMs, toBigInt, toLong, toWire } = require('./common');

async function zAddNx(redis, zkey, member, score) {
  await redis.zAdd(zkey, [{ score: Number(score), value: `${member}` }], { NX: true });
}

async function zRangeRev(redis, zkey, start, stop) {
  if (typeof redis.zRevRange === 'function') {
    return redis.zRevRange(zkey, start, stop);
  }
  return redis.zRange(zkey, start, stop, { REV: true });
}

class UserTimelineHandler {
  constructor({ collection, postStorage, redis, tracer }) {
    this.collection = collection;
    this.postStorage = postStorage;
    this.redis = redis;
    this.tracer = tracer;
  }

  WriteUserTimeline(reqId, postIdValue, userIdValue, timestampValue, carrier) {
    return this.tracer.withSpan('WriteUserTimeline', carrier, async () => {
      const userId = toBigInt(userIdValue);
      const postId = toBigInt(postIdValue);
      const timestamp = toBigInt(timestampValue);
      await Promise.all([
        this.collection.updateOne(
          { user_id: toLong(userId) },
          {
            $push: {
              posts: {
                $each: [{ post_id: toLong(postId), timestamp: toLong(timestamp) }],
                $position: 0
              }
            }
          },
          { upsert: true }
        ),
        zAddNx(this.redis, key(userId), key(postId), timestamp)
      ]);
    });
  }

  async ReadUserTimeline(reqId, userIdValue, start, stop, carrier) {
    return this.tracer.withSpan('ReadUserTimeline', carrier, async (nextCarrier) => {
      if (stop <= start || start < 0) {
        return [];
      }

      const userId = toBigInt(userIdValue);
      const cachedIds = await zRangeRev(this.redis, key(userId), start, stop - 1);
      const postIds = cachedIds.map((value) => BigInt(value));
      const mongoStart = start + postIds.length;
      const redisWarm = new Map();

      if (mongoStart < stop) {
        const doc = await this.collection.findOne(
          { user_id: toLong(userId) },
          { projection: { posts: { $slice: [0, stop] } } }
        );
        const posts = doc?.posts || [];
        for (let idx = 0; idx < posts.length; idx += 1) {
          const currPostId = toBigInt(posts[idx].post_id);
          const currTimestamp = toBigInt(posts[idx].timestamp);
          if (idx >= mongoStart && !postIds.some((existing) => existing === currPostId)) {
            postIds.push(currPostId);
          }
          redisWarm.set(key(currPostId), currTimestamp);
        }
      }

      if (redisWarm.size > 0) {
        await this.redis.zAdd(key(userId), [...redisWarm].map(([value, score]) => ({
          score: Number(score),
          value
        })));
      }

      return this.postStorage.call('ReadPosts', reqId, postIds.map(toWire), nextCarrier);
    });
  }
}

class HomeTimelineHandler {
  constructor({ postStorage, redis, socialGraph, tracer }) {
    this.postStorage = postStorage;
    this.redis = redis;
    this.socialGraph = socialGraph;
    this.tracer = tracer;
  }

  WriteHomeTimeline(reqId, postIdValue, userIdValue, timestampValue, userMentionIds, carrier) {
    return this.tracer.withSpan('WriteHomeTimeline', carrier, async (nextCarrier) => {
      const postId = toBigInt(postIdValue);
      const userId = toBigInt(userIdValue);
      const timestamp = toBigInt(timestampValue || nowMs());
      const followers = await this.socialGraph.call('GetFollowers', reqId, userIdValue, nextCarrier);
      const targets = new Set([
        ...followers.map((follower) => key(follower)),
        ...(userMentionIds || []).map((mentionId) => key(mentionId))
      ]);

      await Promise.all([...targets].map((targetUserId) =>
        zAddNx(this.redis, targetUserId, key(postId), timestamp)));
    });
  }

  ReadHomeTimeline(reqId, userIdValue, start, stop, carrier) {
    return this.tracer.withSpan('ReadHomeTimeline', carrier, async (nextCarrier) => {
      if (stop <= start || start < 0) {
        return [];
      }
      const postIds = (await zRangeRev(this.redis, key(userIdValue), start, stop - 1))
        .map((value) => toWire(BigInt(value)));
      return this.postStorage.call('ReadPosts', reqId, postIds, nextCarrier);
    });
  }
}

module.exports = { HomeTimelineHandler, UserTimelineHandler };
