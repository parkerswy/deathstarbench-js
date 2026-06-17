'use strict';

// Parity: the generated Thrift bindings must serialize the shared structs with
// framed/binary encoding and preserve i64 precision through nested structures,
// matching the C++ gen-cpp wire format defined in media_service.thrift.

const assert = require('node:assert/strict');
const test = require('node:test');
const thrift = require('thrift');

const Types = require('../../gen-nodejs/media_service_types');
const { toBigInt, toWire } = require('../../src/lib/i64');

const WRITE = Symbol.for('write');
const READ = Symbol.for('read');

// In-memory framed/binary round-trip (no server, no datastores).
function roundTrip(Klass, value) {
  let framed;
  const writeTransport = new thrift.TFramedTransport(null, (buffer) => { framed = buffer; });
  const writeProtocol = new thrift.TBinaryProtocol(writeTransport);
  value[WRITE](writeProtocol);
  writeProtocol.flush();

  let decoded;
  thrift.TFramedTransport.receiver((readTransport) => {
    decoded = new Klass();
    decoded[READ](new thrift.TBinaryProtocol(readTransport));
  })(framed);
  return decoded;
}

const HUGE = 9007199254749999n; // beyond Number.MAX_SAFE_INTEGER

test('Review round-trips with precise i64 fields', () => {
  const out = roundTrip(Types.Review, new Types.Review({
    review_id: toWire(HUGE), user_id: toWire(HUGE + 1n), req_id: toWire(HUGE + 2n),
    text: 'great', movie_id: 'movie-1', rating: 5, timestamp: toWire(1700000000000n)
  }));
  assert.equal(toBigInt(out.review_id), HUGE);
  assert.equal(toBigInt(out.user_id), HUGE + 1n);
  assert.equal(out.movie_id, 'movie-1');
  assert.equal(out.rating, 5);
});

test('MovieInfo round-trips nested Cast structs and i64 ids', () => {
  const out = roundTrip(Types.MovieInfo, new Types.MovieInfo({
    movie_id: 'movie-1', title: 'Title',
    casts: [new Types.Cast({ cast_id: 1, character: 'lead', cast_info_id: toWire(HUGE) })],
    plot_id: toWire(HUGE + 5n), thumbnail_ids: ['t'], photo_ids: ['p'], video_ids: ['v'],
    avg_rating: 4.5, num_rating: 3
  }));
  assert.equal(toBigInt(out.casts[0].cast_info_id), HUGE);
  assert.equal(out.casts[0].character, 'lead');
  assert.equal(toBigInt(out.plot_id), HUGE + 5n);
  assert.equal(out.avg_rating, 4.5);
});

test('Page round-trips the fully composed read response', () => {
  const out = roundTrip(Types.Page, new Types.Page({
    movie_info: new Types.MovieInfo({
      movie_id: 'movie-1', title: 'Title', casts: [], plot_id: toWire(1n),
      thumbnail_ids: [], photo_ids: [], video_ids: [], avg_rating: 4, num_rating: 1
    }),
    reviews: [new Types.Review({
      review_id: toWire(HUGE), user_id: toWire(1n), req_id: toWire(2n),
      text: 'r', movie_id: 'movie-1', rating: 5, timestamp: toWire(1700000000000n)
    })],
    cast_infos: [new Types.CastInfo({
      cast_info_id: toWire(HUGE), name: 'actor', gender: true, intro: 'i'
    })],
    plot: 'the plot'
  }));
  assert.equal(out.plot, 'the plot');
  assert.equal(toBigInt(out.reviews[0].review_id), HUGE);
  assert.equal(toBigInt(out.cast_infos[0].cast_info_id), HUGE);
  assert.equal(out.cast_infos[0].gender, true);
});
