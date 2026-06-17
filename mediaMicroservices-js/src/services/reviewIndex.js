'use strict';

const { handlerError } = require('../lib/errors');
const { toBigInt, toLong, toWire, key } = require('./common');

function redisTimestampScore(value) {
  const timestamp = toBigInt(value);
  const score = Number(timestamp);
  if (!Number.isSafeInteger(score)) {
    throw handlerError(`Timestamp ${timestamp} cannot be sorted precisely in Redis`);
  }
  return score;
}

class ReviewIndexHandler {
  constructor({ collection, redis, reviewStorage, tracer, keyField, spanPrefix }) {
    this.collection = collection;
    this.redis = redis;
    this.reviewStorage = reviewStorage;
    this.tracer = tracer;
    this.keyField = keyField;
    this.spanPrefix = spanPrefix;
  }

  selector(entityId) {
    return { [this.keyField]: this.keyField === 'movie_id' ? entityId : toLong(entityId) };
  }

  redisKey(entityId) {
    return this.keyField === 'movie_id' ? entityId : key(entityId);
  }

  async upload(reqId, entityId, reviewId, timestampValue, carrier) {
    return this.tracer.withSpan(`Upload${this.spanPrefix}Review`, carrier, async () => {
      const selector = this.selector(entityId);
      const row = {
        review_id: toLong(reviewId),
        timestamp: toLong(timestampValue)
      };
      await this.collection.updateOne(
        selector,
        { $push: { reviews: { $each: [row], $position: 0 } } },
        { upsert: true }
      );
      const redisKey = this.redisKey(entityId);
      if (await this.redis.zCard(redisKey)) {
        await this.redis.zAdd(redisKey, [{
          score: redisTimestampScore(timestampValue),
          value: key(reviewId)
        }], { NX: true });
      }
    });
  }

  async read(reqId, entityId, start, stop, carrier) {
    return this.tracer.withSpan(`Read${this.spanPrefix}Reviews`, carrier, async (nextCarrier) => {
      if (stop <= start || start < 0) {
        return [];
      }
      const redisKey = this.redisKey(entityId);
      const cachedIds = await this.redis.zRange(redisKey, start, stop - 1, { REV: true });
      const ids = cachedIds.map((id) => BigInt(id));
      const mongoStart = start + ids.length;
      if (mongoStart < stop) {
        const doc = await this.collection.findOne(this.selector(entityId), {
          projection: { reviews: { $slice: [0, stop] } }
        });
        const stored = doc?.reviews || [];
        for (let index = mongoStart; index < Math.min(stop, stored.length); index += 1) {
          ids.push(toBigInt(stored[index].review_id));
        }
        if (stored.length) {
          await this.redis.del(redisKey);
          await this.redis.zAdd(redisKey, stored.map((review) => ({
            score: redisTimestampScore(review.timestamp),
            value: key(review.review_id)
          })), { NX: true });
        }
      }
      return this.reviewStorage.call(
        'ReadReviews',
        reqId,
        ids.map(toWire),
        nextCarrier
      );
    });
  }
}

class MovieReviewHandler extends ReviewIndexHandler {
  UploadMovieReview(reqId, movieId, reviewId, timestampValue, carrier) {
    return this.upload(reqId, movieId, reviewId, timestampValue, carrier);
  }

  ReadMovieReviews(reqId, movieId, start, stop, carrier) {
    return this.read(reqId, movieId, start, stop, carrier);
  }
}

class UserReviewHandler extends ReviewIndexHandler {
  UploadUserReview(reqId, userId, reviewId, timestampValue, carrier) {
    return this.upload(reqId, toBigInt(userId), reviewId, timestampValue, carrier);
  }

  ReadUserReviews(reqId, userId, start, stop, carrier) {
    return this.read(reqId, toBigInt(userId), start, stop, carrier);
  }
}

module.exports = { MovieReviewHandler, ReviewIndexHandler, UserReviewHandler, redisTimestampScore };
