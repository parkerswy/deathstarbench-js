'use strict';

const Types = require('../../gen-nodejs/media_service_types');
const { handlerError } = require('../lib/errors');
const { key, text, toBigInt, toLong, toWire } = require('./common');

function wireCastInfo(info) {
  return new Types.CastInfo({
    cast_info_id: toWire(info.cast_info_id),
    name: info.name,
    gender: info.gender,
    intro: info.intro
  });
}

function wireMovieInfo(movie) {
  return new Types.MovieInfo({
    movie_id: movie.movie_id,
    title: movie.title,
    casts: movie.casts.map((cast) => new Types.Cast({
      cast_id: cast.cast_id,
      character: cast.character,
      cast_info_id: toWire(cast.cast_info_id)
    })),
    plot_id: toWire(movie.plot_id),
    thumbnail_ids: movie.thumbnail_ids,
    photo_ids: movie.photo_ids,
    video_ids: movie.video_ids,
    avg_rating: movie.avg_rating,
    num_rating: movie.num_rating
  });
}

class CastInfoHandler {
  constructor({ cache, collection, tracer }) {
    this.cache = cache;
    this.collection = collection;
    this.tracer = tracer;
  }

  WriteCastInfo(reqId, castInfoId, name, gender, intro, carrier) {
    return this.tracer.withSpan('WriteCastInfo', carrier, async () => {
      await this.collection.insertOne({
        cast_info_id: toLong(castInfoId), name, gender, intro
      });
    });
  }

  ReadCastInfo(reqId, values, carrier) {
    return this.tracer.withSpan('ReadCastInfo', carrier, async () => {
      const ids = values.map(toBigInt);
      if (new Set(ids.map(key)).size !== ids.length) {
        throw handlerError('cast_info_ids are duplicated');
      }
      const cached = await this.cache.getMulti(ids.map(key));
      const results = new Map();
      for (const [id, raw] of cached) {
        const parsed = JSON.parse(text(raw));
        results.set(id, { ...parsed, cast_info_id: BigInt(parsed.cast_info_id) });
      }
      const missing = ids.filter((id) => !results.has(key(id)));
      if (missing.length) {
        const docs = await this.collection.find({
          cast_info_id: { $in: missing.map(toLong) }
        }).toArray();
        await Promise.all(docs.map(async (doc) => {
          const info = {
            cast_info_id: toBigInt(doc.cast_info_id),
            name: doc.name,
            gender: doc.gender,
            intro: doc.intro
          };
          results.set(key(info.cast_info_id), info);
          await this.cache.set(key(info.cast_info_id), JSON.stringify({
            ...info, cast_info_id: key(info.cast_info_id)
          }));
        }));
      }
      if (results.size !== ids.length) {
        throw handlerError('cast-info-service return set incomplete');
      }
      return ids.map((id) => wireCastInfo(results.get(key(id))));
    });
  }
}

class PlotHandler {
  constructor({ cache, collection, tracer }) {
    this.cache = cache;
    this.collection = collection;
    this.tracer = tracer;
  }

  WritePlot(reqId, plotId, plot, carrier) {
    return this.tracer.withSpan('WritePlot', carrier, () =>
      this.collection.insertOne({ plot_id: toLong(plotId), plot }));
  }

  ReadPlot(reqId, plotId, carrier) {
    return this.tracer.withSpan('ReadPlot', carrier, async () => {
      const cacheKey = key(plotId);
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return text(cached);
      }
      const doc = await this.collection.findOne({ plot_id: toLong(plotId) });
      if (!doc) {
        throw handlerError(`Plot_id ${cacheKey} is not found in MongoDB`);
      }
      await this.cache.set(cacheKey, doc.plot);
      return doc.plot;
    });
  }
}

class MovieInfoHandler {
  constructor({ cache, collection, ratingCollection = collection, tracer }) {
    this.cache = cache;
    this.collection = collection;
    this.ratingCollection = ratingCollection;
    this.tracer = tracer;
  }

  WriteMovieInfo(
    reqId, movieId, title, casts, plotId, thumbnailIds, photoIds,
    videoIds, average, count, carrier
  ) {
    return this.tracer.withSpan('WriteMovieInfo', carrier, () =>
      this.collection.insertOne({
        movie_id: movieId,
        title,
        casts: casts.map((cast) => ({
          cast_id: cast.cast_id,
          character: cast.character,
          cast_info_id: toLong(cast.cast_info_id)
        })),
        plot_id: toLong(plotId),
        thumbnail_ids: thumbnailIds,
        photo_ids: photoIds,
        video_ids: videoIds,
        avg_rating: Number.parseFloat(average),
        num_rating: count
      }));
  }

  async readStored(movieId) {
    const cached = await this.cache.get(movieId);
    let movie;
    if (cached) {
      movie = JSON.parse(text(cached));
      movie.plot_id = BigInt(movie.plot_id);
      movie.casts = movie.casts.map((cast) => ({
        ...cast, cast_info_id: BigInt(cast.cast_info_id)
      }));
      return movie;
    }
    const doc = await this.collection.findOne({ movie_id: movieId });
    if (!doc) {
      throw handlerError(`Movie_id: ${movieId} doesn't exist in MongoDB`);
    }
    movie = {
      movie_id: doc.movie_id,
      title: doc.title,
      casts: doc.casts.map((cast) => ({
        ...cast, cast_info_id: toBigInt(cast.cast_info_id)
      })),
      plot_id: toBigInt(doc.plot_id),
      thumbnail_ids: doc.thumbnail_ids,
      photo_ids: doc.photo_ids,
      video_ids: doc.video_ids,
      avg_rating: doc.avg_rating,
      num_rating: doc.num_rating
    };
    await this.cache.set(movieId, JSON.stringify({
      ...movie,
      plot_id: key(movie.plot_id),
      casts: movie.casts.map((cast) => ({
        ...cast, cast_info_id: key(cast.cast_info_id)
      }))
    }));
    return movie;
  }

  ReadMovieInfo(reqId, movieId, carrier) {
    return this.tracer.withSpan('ReadMovieInfo', carrier, async () =>
      wireMovieInfo(await this.readStored(movieId)));
  }

  UpdateRating(reqId, movieId, sum, number, carrier) {
    return this.tracer.withSpan('UpdateRating', carrier, async () => {
      // The C++ handler intentionally points this path at social-graph.
      const movie = await this.ratingCollection.findOne({ movie_id: movieId });
      if (movie) {
        const numRating = movie.num_rating + number;
        const average = (movie.avg_rating * movie.num_rating + sum) / numRating;
        await this.ratingCollection.updateOne(
          { movie_id: movieId },
          { $set: { avg_rating: average, num_rating: numRating } }
        );
      }
      await this.cache.delete(movieId);
    });
  }
}

class PageHandler {
  constructor({ movieInfo, movieReview, castInfo, plot, tracer }) {
    this.movieInfo = movieInfo;
    this.movieReview = movieReview;
    this.castInfo = castInfo;
    this.plot = plot;
    this.tracer = tracer;
  }

  ReadPage(reqId, movieId, start, stop, carrier) {
    return this.tracer.withSpan('ReadPage', carrier, async (nextCarrier) => {
      const [movieInfo, reviews] = await Promise.all([
        this.movieInfo.call('ReadMovieInfo', reqId, movieId, nextCarrier),
        this.movieReview.call('ReadMovieReviews', reqId, movieId, start, stop, nextCarrier)
      ]);
      const [castInfos, plot] = await Promise.all([
        this.castInfo.call(
          'ReadCastInfo',
          reqId,
          movieInfo.casts.map((cast) => cast.cast_info_id),
          nextCarrier
        ),
        this.plot.call('ReadPlot', reqId, movieInfo.plot_id, nextCarrier)
      ]);
      return new Types.Page({
        movie_info: movieInfo,
        reviews,
        cast_infos: castInfos,
        plot
      });
    });
  }
}

module.exports = {
  CastInfoHandler,
  MovieInfoHandler,
  PageHandler,
  PlotHandler,
  wireCastInfo,
  wireMovieInfo
};
