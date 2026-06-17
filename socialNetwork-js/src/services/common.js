'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const Types = require('../../gen-nodejs/social_network_types');
const { key, timestamp, toBigInt, toLong, toWire } = require('../lib/i64');

function text(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : `${value}`;
}

function nowMs() {
  return BigInt(Date.now());
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function randomString(length) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (const byte of bytes) {
    result += chars[byte % chars.length];
  }
  return result;
}

function randomUrlSuffix(length = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(length);
  let result = '';
  for (const byte of bytes) {
    result += chars[byte % chars.length];
  }
  return result;
}

function signLoginToken({ secret, userId, username, nowSeconds = Math.floor(Date.now() / 1000) }) {
  return jwt.sign({
    user_id: key(userId),
    username,
    timestamp: `${nowSeconds}`,
    ttl: '3600'
  }, secret, { algorithm: 'HS256', noTimestamp: true });
}

function wireCreator(value) {
  return new Types.Creator({
    user_id: toWire(value.user_id),
    username: value.username
  });
}

function wireMedia(value) {
  return new Types.Media({
    media_id: toWire(value.media_id),
    media_type: value.media_type
  });
}

function wireUrl(value) {
  return new Types.Url({
    shortened_url: value.shortened_url,
    expanded_url: value.expanded_url
  });
}

function wireUserMention(value) {
  return new Types.UserMention({
    user_id: toWire(value.user_id),
    username: value.username
  });
}

function wireTextReturn(value) {
  return new Types.TextServiceReturn({
    text: value.text,
    user_mentions: value.user_mentions.map(wireUserMention),
    urls: value.urls.map(wireUrl)
  });
}

function normalizePost(post) {
  return {
    post_id: toBigInt(post.post_id),
    creator: {
      user_id: toBigInt(post.creator.user_id),
      username: post.creator.username
    },
    req_id: toBigInt(post.req_id),
    text: post.text,
    user_mentions: (post.user_mentions || []).map((mention) => ({
      user_id: toBigInt(mention.user_id),
      username: mention.username
    })),
    media: (post.media || []).map((item) => ({
      media_id: toBigInt(item.media_id),
      media_type: item.media_type
    })),
    urls: (post.urls || []).map((url) => ({
      shortened_url: url.shortened_url,
      expanded_url: url.expanded_url
    })),
    timestamp: toBigInt(post.timestamp),
    post_type: post.post_type
  };
}

function wirePost(value) {
  const post = normalizePost(value);
  return new Types.Post({
    post_id: toWire(post.post_id),
    creator: wireCreator(post.creator),
    req_id: toWire(post.req_id),
    text: post.text,
    user_mentions: post.user_mentions.map(wireUserMention),
    media: post.media.map(wireMedia),
    urls: post.urls.map(wireUrl),
    timestamp: toWire(post.timestamp),
    post_type: post.post_type
  });
}

function postDocument(value) {
  const post = normalizePost(value);
  return {
    post_id: toLong(post.post_id),
    timestamp: toLong(post.timestamp),
    text: post.text,
    req_id: toLong(post.req_id),
    post_type: post.post_type,
    creator: {
      user_id: toLong(post.creator.user_id),
      username: post.creator.username
    },
    urls: post.urls.map((url) => ({ ...url })),
    user_mentions: post.user_mentions.map((mention) => ({
      user_id: toLong(mention.user_id),
      username: mention.username
    })),
    media: post.media.map((item) => ({
      media_id: toLong(item.media_id),
      media_type: item.media_type
    }))
  };
}

function postFromDocument(doc) {
  return {
    post_id: toBigInt(doc.post_id),
    timestamp: toBigInt(doc.timestamp),
    text: doc.text,
    req_id: toBigInt(doc.req_id),
    post_type: doc.post_type,
    creator: {
      user_id: toBigInt(doc.creator.user_id),
      username: doc.creator.username
    },
    urls: (doc.urls || []).map((url) => ({ ...url })),
    user_mentions: (doc.user_mentions || []).map((mention) => ({
      user_id: toBigInt(mention.user_id),
      username: mention.username
    })),
    media: (doc.media || []).map((item) => ({
      media_id: toBigInt(item.media_id),
      media_type: item.media_type
    }))
  };
}

function postCacheValue(value) {
  const post = normalizePost(value);
  return JSON.stringify({
    post_id: key(post.post_id),
    timestamp: key(post.timestamp),
    text: post.text,
    req_id: key(post.req_id),
    post_type: post.post_type,
    creator: {
      user_id: key(post.creator.user_id),
      username: post.creator.username
    },
    urls: post.urls,
    user_mentions: post.user_mentions.map((mention) => ({
      user_id: key(mention.user_id),
      username: mention.username
    })),
    media: post.media.map((item) => ({
      media_id: key(item.media_id),
      media_type: item.media_type
    }))
  });
}

function postFromCache(value) {
  return postFromDocument(JSON.parse(text(value)));
}

module.exports = {
  hashPassword,
  key,
  normalizePost,
  nowMs,
  postCacheValue,
  postDocument,
  postFromCache,
  postFromDocument,
  randomString,
  randomUrlSuffix,
  signLoginToken,
  text,
  timestamp,
  toBigInt,
  toLong,
  toWire,
  wireCreator,
  wireMedia,
  wirePost,
  wireTextReturn,
  wireUrl,
  wireUserMention
};
