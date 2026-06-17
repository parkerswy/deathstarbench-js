'use strict';

const { handlerError } = require('../lib/errors');
const {
  key,
  reviewDocument,
  reviewFromDocument,
  toBigInt,
  toLong,
  wireReview
} = require('./common');

function encodeReview(review) {
  return JSON.stringify({
    review_id: key(review.review_id),
    user_id: key(review.user_id),
    req_id: key(review.req_id),
    text: review.text,
    movie_id: review.movie_id,
    rating: review.rating,
    timestamp: key(review.timestamp)
  });
}

function decodeReview(value) {
  const doc = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : value);
  return {
    review_id: BigInt(doc.review_id),
    user_id: BigInt(doc.user_id),
    req_id: BigInt(doc.req_id),
    text: doc.text,
    movie_id: doc.movie_id,
    rating: doc.rating,
    timestamp: BigInt(doc.timestamp)
  };
}

class ReviewStorageHandler {
  constructor({ cache, collection, tracer }) {
    this.cache = cache;
    this.collection = collection;
    this.tracer = tracer;
  }

  StoreReview(reqId, wireValue, carrier) {
    return this.tracer.withSpan('StoreReview', carrier, async () => {
      const review = {
        review_id: toBigInt(wireValue.review_id),
        user_id: toBigInt(wireValue.user_id),
        req_id: toBigInt(wireValue.req_id),
        text: wireValue.text,
        movie_id: wireValue.movie_id,
        rating: wireValue.rating,
        timestamp: toBigInt(wireValue.timestamp)
      };
      await this.collection.insertOne(reviewDocument(review));
    });
  }

  ReadReviews(reqId, wireIds, carrier) {
    return this.tracer.withSpan('ReadReviews', carrier, async () => {
      const ids = wireIds.map(toBigInt);
      if (!ids.length) {
        return [];
      }
      const unique = new Set(ids.map(key));
      if (unique.size !== ids.length) {
        throw handlerError('Post_ids are duplicated');
      }
      const values = await this.cache.getMulti(ids.map(key));
      const reviews = new Map();
      for (const [id, value] of values) {
        reviews.set(id, decodeReview(value));
      }
      const missing = ids.filter((id) => !reviews.has(key(id)));
      if (missing.length) {
        const docs = await this.collection.find({
          review_id: { $in: missing.map(toLong) }
        }).toArray();
        await Promise.all(docs.map(async (doc) => {
          const review = reviewFromDocument(doc);
          reviews.set(key(review.review_id), review);
          await this.cache.set(key(review.review_id), encodeReview(review));
        }));
      }
      if (reviews.size !== ids.length) {
        throw handlerError('review storage service: return set incomplete');
      }
      return ids.map((id) => wireReview(reviews.get(key(id))));
    });
  }
}

module.exports = { ReviewStorageHandler, decodeReview, encodeReview };

