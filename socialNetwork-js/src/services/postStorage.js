'use strict';

const { handlerError } = require('../lib/errors');
const {
  key,
  postCacheValue,
  postDocument,
  postFromCache,
  postFromDocument,
  toBigInt,
  toLong,
  wirePost
} = require('./common');

class PostStorageHandler {
  constructor({ cache, collection, tracer }) {
    this.cache = cache;
    this.collection = collection;
    this.tracer = tracer;
  }

  StorePost(reqId, post, carrier) {
    return this.tracer.withSpan('StorePost', carrier, async () => {
      await this.collection.insertOne(postDocument(post));
    });
  }

  async readPost(postIdValue) {
    const postId = toBigInt(postIdValue);
    const cacheKey = key(postId);
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return postFromCache(cached);
    }

    const doc = await this.collection.findOne({ post_id: toLong(postId) });
    if (!doc) {
      throw handlerError(`Post_id: ${cacheKey} doesn't exist in MongoDB`);
    }
    const post = postFromDocument(doc);
    await this.cache.set(cacheKey, postCacheValue(post));
    return post;
  }

  async ReadPost(reqId, postId, carrier) {
    return this.tracer.withSpan('ReadPost', carrier, async () =>
      wirePost(await this.readPost(postId)));
  }

  async ReadPosts(reqId, postIds, carrier) {
    return this.tracer.withSpan('ReadPosts', carrier, async () => {
      if (!postIds || postIds.length === 0) {
        return [];
      }

      const ids = postIds.map(toBigInt);
      if (new Set(ids.map(key)).size !== ids.length) {
        throw handlerError('Post_ids are duplicated');
      }

      const cacheKeys = ids.map(key);
      const cached = await this.cache.getMulti(cacheKeys);
      const posts = new Map();
      for (const id of ids) {
        const cachedValue = cached.get(key(id));
        if (cachedValue) {
          const post = postFromCache(cachedValue);
          posts.set(key(post.post_id), post);
        }
      }

      const missing = ids.filter((id) => !posts.has(key(id)));
      if (missing.length > 0) {
        const docs = await this.collection.find({
          post_id: { $in: missing.map(toLong) }
        }).toArray();
        await Promise.all(docs.map(async (doc) => {
          const post = postFromDocument(doc);
          posts.set(key(post.post_id), post);
          await this.cache.set(key(post.post_id), postCacheValue(post));
        }));
      }

      if (posts.size !== ids.length) {
        throw handlerError('Return set incomplete');
      }

      return ids.map((id) => wirePost(posts.get(key(id))));
    });
  }
}

module.exports = { PostStorageHandler };
