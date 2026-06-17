'use strict';

const { handlerError } = require('../lib/errors');
const { key, nowMs, toBigInt, toLong, toWire } = require('./common');

async function zAddNx(redis, zkey, member, score) {
  await redis.zAdd(zkey, [{ score: Number(score), value: `${member}` }], { NX: true });
}

class SocialGraphHandler {
  constructor({ collection, redis, userService, tracer }) {
    this.collection = collection;
    this.redis = redis;
    this.userService = userService;
    this.tracer = tracer;
  }

  InsertUser(reqId, userId, carrier) {
    return this.tracer.withSpan('InsertUser', carrier, async () => {
      await this.collection.insertOne({
        user_id: toLong(userId),
        followers: [],
        followees: []
      });
    });
  }

  async Follow(reqId, userIdValue, followeeIdValue, carrier) {
    return this.tracer.withSpan('Follow', carrier, async () => {
      const userId = toBigInt(userIdValue);
      const followeeId = toBigInt(followeeIdValue);
      const timestamp = nowMs();
      const [userUpdate, followeeUpdate] = await Promise.all([
        this.collection.updateOne(
          { user_id: toLong(userId), 'followees.user_id': { $ne: toLong(followeeId) } },
          { $push: { followees: { user_id: toLong(followeeId), timestamp: toLong(timestamp) } } }
        ),
        this.collection.updateOne(
          { user_id: toLong(followeeId), 'followers.user_id': { $ne: toLong(userId) } },
          { $push: { followers: { user_id: toLong(userId), timestamp: toLong(timestamp) } } }
        )
      ]);
      if (userUpdate.matchedCount === 0 && followeeUpdate.matchedCount === 0) {
        return;
      }
      await Promise.all([
        zAddNx(this.redis, `${key(userId)}:followees`, key(followeeId), timestamp),
        zAddNx(this.redis, `${key(followeeId)}:followers`, key(userId), timestamp)
      ]);
    });
  }

  async Unfollow(reqId, userIdValue, followeeIdValue, carrier) {
    return this.tracer.withSpan('Unfollow', carrier, async () => {
      const userId = toBigInt(userIdValue);
      const followeeId = toBigInt(followeeIdValue);
      await Promise.all([
        this.collection.updateOne(
          { user_id: toLong(userId) },
          { $pull: { followees: { user_id: toLong(followeeId) } } }
        ),
        this.collection.updateOne(
          { user_id: toLong(followeeId) },
          { $pull: { followers: { user_id: toLong(userId) } } }
        ),
        this.redis.zRem(`${key(userId)}:followees`, key(followeeId)),
        this.redis.zRem(`${key(followeeId)}:followers`, key(userId))
      ]);
    });
  }

  async resolveUserIds(reqId, username, followeeUsername, carrier) {
    const [userId, followeeId] = await Promise.all([
      this.userService.call('GetUserId', reqId, username, carrier).then(toBigInt),
      this.userService.call('GetUserId', reqId, followeeUsername, carrier).then(toBigInt)
    ]);
    return { userId, followeeId };
  }

  async FollowWithUsername(reqId, username, followeeUsername, carrier) {
    return this.tracer.withSpan('FollowWithUsername', carrier, async (nextCarrier) => {
      const { userId, followeeId } = await this.resolveUserIds(
        reqId,
        username,
        followeeUsername,
        nextCarrier
      );
      await this.Follow(reqId, userId, followeeId, nextCarrier);
    });
  }

  async UnfollowWithUsername(reqId, username, followeeUsername, carrier) {
    return this.tracer.withSpan('UnfollowWithUsername', carrier, async (nextCarrier) => {
      const { userId, followeeId } = await this.resolveUserIds(
        reqId,
        username,
        followeeUsername,
        nextCarrier
      );
      await this.Unfollow(reqId, userId, followeeId, nextCarrier);
    });
  }

  async readEdgeList(userIdValue, field, redisSuffix) {
    const userId = toBigInt(userIdValue);
    const zkey = `${key(userId)}:${redisSuffix}`;
    const cached = await this.redis.zRange(zkey, 0, -1);
    if (cached.length > 0) {
      return cached.map((value) => BigInt(value));
    }

    const doc = await this.collection.findOne({ user_id: toLong(userId) });
    if (!doc) {
      if (field === 'followees') {
        throw handlerError('Cannot find user_id in MongoDB.');
      }
      return [];
    }

    const entries = doc[field] || [];
    if (entries.length > 0) {
      await this.redis.zAdd(zkey, entries.map((entry) => ({
        score: Number(toBigInt(entry.timestamp)),
        value: key(entry.user_id)
      })));
    }
    return entries.map((entry) => toBigInt(entry.user_id));
  }

  GetFollowers(reqId, userId, carrier) {
    return this.tracer.withSpan('GetFollowers', carrier, async () => {
      const followers = await this.readEdgeList(userId, 'followers', 'followers');
      return followers.map(toWire);
    });
  }

  GetFollowees(reqId, userId, carrier) {
    return this.tracer.withSpan('GetFollowees', carrier, async () => {
      const followees = await this.readEdgeList(userId, 'followees', 'followees');
      return followees.map(toWire);
    });
  }
}

module.exports = { SocialGraphHandler };
