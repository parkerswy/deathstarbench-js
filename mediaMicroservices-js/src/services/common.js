'use strict';

const crypto = require('node:crypto');

const Types = require('../../gen-nodejs/media_service_types');
const { key, toBigInt, toLong, toWire } = require('../lib/i64');

function text(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : `${value}`;
}

function wireReview(review) {
  return new Types.Review({
    review_id: toWire(review.review_id),
    user_id: toWire(review.user_id),
    req_id: toWire(review.req_id),
    text: review.text,
    movie_id: review.movie_id,
    rating: review.rating,
    timestamp: toWire(review.timestamp)
  });
}

function reviewDocument(review) {
  return {
    review_id: toLong(review.review_id),
    user_id: toLong(review.user_id),
    req_id: toLong(review.req_id),
    text: review.text,
    movie_id: review.movie_id,
    rating: review.rating,
    timestamp: toLong(review.timestamp)
  };
}

function reviewFromDocument(doc) {
  return {
    review_id: toBigInt(doc.review_id),
    user_id: toBigInt(doc.user_id),
    req_id: toBigInt(doc.req_id),
    text: doc.text,
    movie_id: doc.movie_id,
    rating: doc.rating,
    timestamp: toBigInt(doc.timestamp)
  };
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function randomSalt() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(32);
  let result = '';
  for (const byte of bytes) {
    result += chars[byte % chars.length];
  }
  return result;
}

module.exports = {
  hashPassword,
  key,
  randomSalt,
  reviewDocument,
  reviewFromDocument,
  text,
  toBigInt,
  toLong,
  toWire,
  wireReview
};

