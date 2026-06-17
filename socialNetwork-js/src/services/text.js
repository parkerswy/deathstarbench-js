'use strict';

const { handlerError } = require('../lib/errors');
const {
  key,
  randomUrlSuffix,
  text,
  toBigInt,
  toLong,
  wireMedia,
  wireTextReturn,
  wireUrl,
  wireUserMention
} = require('./common');

const SHORT_URL_HOST = 'http://short-url/';

class UrlShortenHandler {
  constructor({ collection, tracer }) {
    this.collection = collection;
    this.tracer = tracer;
  }

  ComposeUrls(reqId, urls, carrier) {
    return this.tracer.withSpan('ComposeUrls', carrier, async () => {
      const shortened = (urls || []).map((expandedUrl) => ({
        expanded_url: expandedUrl,
        shortened_url: `${SHORT_URL_HOST}${randomUrlSuffix(10)}`
      }));
      if (shortened.length > 0) {
        await this.collection.insertMany(shortened);
      }
      return shortened.map(wireUrl);
    });
  }

  GetExtendedUrls(reqId, shortenedUrls, carrier) {
    return this.tracer.withSpan('GetExtendedUrls', carrier, async () => []);
  }
}

class UserMentionHandler {
  constructor({ cache, collection, tracer }) {
    this.cache = cache;
    this.collection = collection;
    this.tracer = tracer;
  }

  async ComposeUserMentions(reqId, usernames, carrier) {
    return this.tracer.withSpan('ComposeUserMentions', carrier, async () => {
      const uniqueNames = [...new Set(usernames || [])];
      if (uniqueNames.length === 0) {
        return [];
      }

      const results = new Map();
      const cacheKeys = uniqueNames.map((username) => `${username}:user_id`);
      const cached = await this.cache.getMulti(cacheKeys);
      for (const username of uniqueNames) {
        const cachedValue = cached.get(`${username}:user_id`);
        if (cachedValue !== undefined) {
          results.set(username, { username, user_id: BigInt(text(cachedValue)) });
        }
      }

      const missing = uniqueNames.filter((username) => !results.has(username));
      if (missing.length > 0) {
        const docs = await this.collection.find({ username: { $in: missing } }).toArray();
        await Promise.all(docs.map(async (doc) => {
          const userId = toBigInt(doc.user_id);
          results.set(doc.username, { username: doc.username, user_id: userId });
          await this.cache.set(`${doc.username}:user_id`, key(userId));
        }));
      }

      return uniqueNames
        .filter((username) => results.has(username))
        .map((username) => wireUserMention(results.get(username)));
    });
  }
}

class TextHandler {
  constructor({ urlShorten, userMention, tracer }) {
    this.urlShorten = urlShorten;
    this.userMention = userMention;
    this.tracer = tracer;
  }

  async ComposeText(reqId, value, carrier) {
    return this.tracer.withSpan('ComposeText', carrier, async (nextCarrier) => {
      const mentionUsernames = [...value.matchAll(/@[a-zA-Z0-9\-_]+/g)]
        .map((match) => match[0].slice(1));
      const urls = [...value.matchAll(/(http:\/\/|https:\/\/)([a-zA-Z0-9_!~*'().&=+$%-]+)/g)]
        .map((match) => match[0]);

      const [shortenedUrls, userMentions] = await Promise.all([
        this.urlShorten.call('ComposeUrls', reqId, urls, nextCarrier),
        this.userMention.call('ComposeUserMentions', reqId, mentionUsernames, nextCarrier)
      ]);

      let updatedText = value;
      if (urls.length > 0) {
        let idx = 0;
        updatedText = '';
        let remaining = value;
        const matcher = /(http:\/\/|https:\/\/)([a-zA-Z0-9_!~*'().&=+$%-]+)/;
        let match = remaining.match(matcher);
        while (match) {
          updatedText += remaining.slice(0, match.index) + shortenedUrls[idx].shortened_url;
          remaining = remaining.slice(match.index + match[0].length);
          idx += 1;
          match = remaining.match(matcher);
        }
      }

      return wireTextReturn({
        text: updatedText,
        urls: shortenedUrls.map((url) => ({
          shortened_url: url.shortened_url,
          expanded_url: url.expanded_url
        })),
        user_mentions: userMentions.map((mention) => ({
          user_id: toBigInt(mention.user_id),
          username: mention.username
        }))
      });
    });
  }
}

class MediaHandler {
  constructor({ tracer }) {
    this.tracer = tracer;
  }

  ComposeMedia(reqId, mediaTypes, mediaIds, carrier) {
    return this.tracer.withSpan('ComposeMedia', carrier, async () => {
      if ((mediaTypes || []).length !== (mediaIds || []).length) {
        throw handlerError('The lengths of media_id list and media_type list are not equal');
      }
      return mediaIds.map((mediaId, idx) => wireMedia({
        media_id: mediaId,
        media_type: mediaTypes[idx]
      }));
    });
  }
}

module.exports = {
  MediaHandler,
  SHORT_URL_HOST,
  TextHandler,
  UrlShortenHandler,
  UserMentionHandler
};
