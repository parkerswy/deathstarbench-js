'use strict';

const { handlerError } = require('../lib/errors');
const { timestamp } = require('../lib/i64');
const { wireReview, key, text, toBigInt, toWire } = require('./common');

const COMPONENT_TTL_SECONDS = 10;
const NUM_COMPONENTS = 5;

class TextHandler {
  constructor({ compose, tracer }) {
    this.compose = compose;
    this.tracer = tracer;
  }

  UploadText(reqId, value, carrier) {
    return this.tracer.withSpan('UploadText', carrier, (nextCarrier) =>
      this.compose.call('UploadText', reqId, value, nextCarrier));
  }
}

class UniqueIdHandler {
  constructor({ compose, generator, tracer }) {
    this.compose = compose;
    this.generator = generator;
    this.tracer = tracer;
  }

  UploadUniqueId(reqId, carrier) {
    return this.tracer.withSpan('UploadUniqueId', carrier, (nextCarrier) =>
      this.compose.call('UploadUniqueId', reqId, toWire(this.generator.next()), nextCarrier));
  }
}

class RatingHandler {
  constructor({ compose, redis, tracer }) {
    this.compose = compose;
    this.redis = redis;
    this.tracer = tracer;
  }

  UploadRating(reqId, movieId, rating, carrier) {
    return this.tracer.withSpan('UploadRating', carrier, async (nextCarrier) => {
      await Promise.all([
        this.compose.call('UploadRating', reqId, rating, nextCarrier),
        Promise.all([
          this.redis.incrBy(`${movieId}:uncommit_sum`, rating),
          this.redis.incr(`${movieId}:uncommit_num`)
        ])
      ]);
    });
  }
}

class MovieIdHandler {
  constructor({ cache, collection, compose, rating, tracer }) {
    this.cache = cache;
    this.collection = collection;
    this.compose = compose;
    this.rating = rating;
    this.tracer = tracer;
  }

  async UploadMovieId(reqId, title, ratingValue, carrier) {
    return this.tracer.withSpan('UploadMovieId', carrier, async (nextCarrier) => {
      let movieId;
      const cached = await this.cache.get(title);
      if (cached) {
        movieId = text(cached);
      } else {
        const movie = await this.collection.findOne({ title });
        if (!movie) {
          throw handlerError(`Movie ${title} is not found in MongoDB`);
        }
        movieId = movie.movie_id;
      }
      await Promise.all([
        this.cache.set(title, movieId),
        this.compose.call('UploadMovieId', reqId, movieId, nextCarrier),
        this.rating.call('UploadRating', reqId, movieId, ratingValue, nextCarrier)
      ]);
    });
  }

  async RegisterMovieId(reqId, title, movieId, carrier) {
    return this.tracer.withSpan('RegisterMovieId', carrier, async () => {
      if (await this.collection.findOne({ title })) {
        throw handlerError(`Movie ${title} already existed in MongoDB`);
      }
      await this.collection.insertOne({ title, movie_id: movieId });
    });
  }
}

class ComposeReviewHandler {
  constructor({ cache, reviewStorage, userReview, movieReview, tracer }) {
    this.cache = cache;
    this.reviewStorage = reviewStorage;
    this.userReview = userReview;
    this.movieReview = movieReview;
    this.tracer = tracer;
  }

  async uploadComponent(reqId, suffix, value, carrier) {
    const requestKey = key(reqId);
    const counterKey = `${requestKey}:counter`;
    const componentKey = `${requestKey}:${suffix}`;
    await this.cache.add(counterKey, '0', { expires: COMPONENT_TTL_SECONDS });
    const added = await this.cache.add(componentKey, `${value}`, { expires: COMPONENT_TTL_SECONDS });
    const count = added ?
      await this.cache.increment(counterKey, 1) :
      Number.parseInt(text(await this.cache.get(counterKey)), 10);
    if (Number(count) === NUM_COMPONENTS) {
      await this.compose(reqId, carrier);
    }
  }

  async compose(reqId, carrier) {
    const requestKey = key(reqId);
    const keys = ['review_id', 'movie_id', 'user_id', 'text', 'rating']
      .map((part) => `${requestKey}:${part}`);
    const values = await this.cache.getMulti(keys);
    if (values.size !== NUM_COMPONENTS) {
      throw handlerError(`Cannot get components of request ${requestKey}`);
    }
    const review = {
      review_id: BigInt(text(values.get(`${requestKey}:review_id`))),
      user_id: BigInt(text(values.get(`${requestKey}:user_id`))),
      req_id: toBigInt(reqId),
      text: text(values.get(`${requestKey}:text`)),
      movie_id: text(values.get(`${requestKey}:movie_id`)),
      rating: Number.parseInt(text(values.get(`${requestKey}:rating`)), 10),
      timestamp: timestamp()
    };
    const outbound = wireReview(review);
    await Promise.all([
      this.reviewStorage.call('StoreReview', reqId, outbound, carrier),
      this.userReview.call(
        'UploadUserReview',
        reqId,
        toWire(review.user_id),
        toWire(review.review_id),
        toWire(review.timestamp),
        carrier
      ),
      this.movieReview.call(
        'UploadMovieReview',
        reqId,
        review.movie_id,
        toWire(review.review_id),
        toWire(review.timestamp),
        carrier
      )
    ]);
  }

  UploadText(reqId, value, carrier) {
    return this.tracer.withSpan('UploadText', carrier, (nextCarrier) =>
      this.uploadComponent(reqId, 'text', value, nextCarrier));
  }

  UploadRating(reqId, value, carrier) {
    return this.tracer.withSpan('UploadRating', carrier, (nextCarrier) =>
      this.uploadComponent(reqId, 'rating', value, nextCarrier));
  }

  UploadMovieId(reqId, value, carrier) {
    return this.tracer.withSpan('UploadMovieId', carrier, (nextCarrier) =>
      this.uploadComponent(reqId, 'movie_id', value, nextCarrier));
  }

  UploadUniqueId(reqId, value, carrier) {
    return this.tracer.withSpan('UploadUniqueId', carrier, (nextCarrier) =>
      this.uploadComponent(reqId, 'review_id', key(value), nextCarrier));
  }

  UploadUserId(reqId, value, carrier) {
    return this.tracer.withSpan('UploadUserId', carrier, (nextCarrier) =>
      this.uploadComponent(reqId, 'user_id', key(value), nextCarrier));
  }
}

module.exports = {
  ComposeReviewHandler,
  MovieIdHandler,
  RatingHandler,
  TextHandler,
  UniqueIdHandler
};
