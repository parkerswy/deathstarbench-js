'use strict';

// Live-stack differential test for the mediaMicroservices JavaScript port.
//
// Drives the same gateway writes against the original C++ stack and this JS
// stack, then reads the composed page from each stack through framed/binary
// Thrift PageService clients. The C++ stack is the oracle; per-stack generated
// review/user/request IDs and timestamps are normalized away.
//
// This is opt-in because it needs both stacks running with PageService exposed:
//
//   DIFF_CPP_URL=http://localhost:8080 \
//   DIFF_JS_URL=http://localhost:18080 \
//   DIFF_CPP_PAGE_ADDR=127.0.0.1:10013 \
//   DIFF_JS_PAGE_ADDR=127.0.0.1:11013 \
//   npm run test:diff
//
// The stock C++ compose file does not publish PageService. Add it with an
// override similar to:
//
//   services:
//     page-service:
//       image: yg397/media-microservices
//       hostname: page-service
//       entrypoint: PageService
//       ports: ["10013:9090"]
//       restart: always
//
// The JS stack already defines PageService behind the "page" profile; publish it
// on a different host port with an override when running beside the C++ stack.

const assert = require('node:assert/strict');
const test = require('node:test');
const thrift = require('thrift');

const PageService = require('../gen-nodejs/PageService');
const { toBigInt, toWire } = require('../src/lib/i64');

const CPP_URL = process.env.DIFF_CPP_URL;
const JS_URL = process.env.DIFF_JS_URL;
const CPP_PAGE_ADDR = process.env.DIFF_CPP_PAGE_ADDR;
const JS_PAGE_ADDR = process.env.DIFF_JS_PAGE_ADDR;
const skip = (!CPP_URL || !JS_URL || !CPP_PAGE_ADDR || !JS_PAGE_ADDR) &&
  'set DIFF_CPP_URL, DIFF_JS_URL, DIFF_CPP_PAGE_ADDR, and DIFF_JS_PAGE_ADDR to run';

const wireOptions = { transport: thrift.TFramedTransport, protocol: thrift.TBinaryProtocol };

function parseAddress(value) {
  const match = /^(.*):(\d+)$/.exec(value || '');
  if (!match) {
    throw new Error(`Invalid PageService address "${value}", expected host:port`);
  }
  return { host: match[1], port: Number.parseInt(match[2], 10) };
}

function pageClient(address, t) {
  const { host, port } = parseAddress(address);
  const connection = thrift.createConnection(host, port, wireOptions);
  connection.on('error', () => {});
  t.after(() => connection.end());
  return thrift.createClient(PageService, connection);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(base, path, { form, json }) {
  const headers = {};
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(base + path, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}

async function onBoth(path, payload, expectedStatus = 200) {
  const [cpp, js] = await Promise.all([
    post(CPP_URL, path, payload),
    post(JS_URL, path, payload)
  ]);
  assert.equal(js.status, cpp.status, `${path} status diverged between C++ and JS`);
  assert.equal(js.text, cpp.text, `${path} body diverged between C++ and JS`);
  assert.equal(js.status, expectedStatus, `${path} returned ${js.status}: ${js.text}`);
  return { cpp, js };
}

function key(value) {
  return toBigInt(value).toString(10);
}

function normalizeMovieInfo(movieInfo) {
  return {
    movie_id: movieInfo.movie_id,
    title: movieInfo.title,
    casts: (movieInfo.casts || [])
      .map((cast) => ({
        cast_id: cast.cast_id,
        character: cast.character || '',
        cast_info_id: key(cast.cast_info_id)
      }))
      .sort((a, b) => a.cast_id - b.cast_id),
    plot_id: key(movieInfo.plot_id),
    thumbnail_ids: movieInfo.thumbnail_ids || [],
    photo_ids: movieInfo.photo_ids || [],
    video_ids: movieInfo.video_ids || [],
    avg_rating: movieInfo.avg_rating,
    num_rating: movieInfo.num_rating
  };
}

function normalizeReview(review) {
  return {
    text: review.text,
    movie_id: review.movie_id,
    rating: review.rating
  };
}

function normalizePage(page) {
  return {
    movie_info: normalizeMovieInfo(page.movie_info),
    reviews: (page.reviews || []).map(normalizeReview),
    cast_infos: (page.cast_infos || [])
      .map((cast) => ({
        cast_info_id: key(cast.cast_info_id),
        name: cast.name,
        gender: cast.gender,
        intro: cast.intro
      }))
      .sort((a, b) => a.cast_info_id.localeCompare(b.cast_info_id)),
    plot: page.plot
  };
}

test('differential: identical media writes produce identical C++ and JS pages', { skip }, async (t) => {
  const cppPage = pageClient(CPP_PAGE_ADDR, t);
  const jsPage = pageClient(JS_PAGE_ADDR, t);

  const base = BigInt(Date.now() % 1_000_000_000);
  const movieId = `diff_movie_${base}`;
  const title = `Differential Movie ${base}`;
  const username = `diff_user_${base}`;
  const password = `pw_${base}`;
  const castId = base + 10_000n;
  const plotId = base + 20_000n;

  await onBoth('/wrk2-api/user/register', {
    form: {
      first_name: 'Diff',
      last_name: 'User',
      username,
      password
    }
  });

  await onBoth('/wrk2-api/movie/register', {
    form: { title, movie_id: movieId }
  });

  await onBoth('/wrk2-api/cast-info/write', {
    json: {
      cast_info_id: Number(castId),
      name: 'Differential Actor',
      gender: true,
      intro: 'same actor bio'
    }
  });

  await onBoth('/wrk2-api/plot/write', {
    json: {
      plot_id: Number(plotId),
      plot: 'same plot text'
    }
  });

  await onBoth('/wrk2-api/movie-info/write', {
    json: {
      movie_id: movieId,
      title,
      casts: [{
        cast_id: 1,
        // The upstream gateway reads "charactor" but the generated Thrift field
        // is "character"; both stacks therefore drop this value. The normalized
        // read below locks that odd but compatible behavior in.
        charactor: 'Lead',
        cast_info_id: Number(castId)
      }],
      plot_id: Number(plotId),
      thumbnail_ids: ['thumb-a'],
      photo_ids: ['photo-a'],
      video_ids: ['video-a'],
      avg_rating: 4.5,
      num_rating: 2
    }
  });

  await onBoth('/wrk2-api/review/compose', {
    form: {
      title,
      text: 'first differential review',
      username,
      password,
      rating: '4'
    }
  });
  await wait(25);
  await onBoth('/wrk2-api/review/compose', {
    form: {
      title,
      text: 'second differential review',
      username,
      password,
      rating: '5'
    }
  });

  await wait(250);

  const reqId = toWire(base + 30_000n);
  const [cpp, js] = await Promise.all([
    cppPage.ReadPage(reqId, movieId, 0, 10, {}),
    jsPage.ReadPage(reqId, movieId, 0, 10, {})
  ]);

  const normCpp = normalizePage(cpp);
  const normJs = normalizePage(js);
  assert.deepEqual(normJs, normCpp, 'PageService output diverged between C++ and JS');
  assert.deepEqual(normJs.reviews.map((review) => review.text), [
    'second differential review',
    'first differential review'
  ], 'expected newest-first review order');
  assert.equal(normJs.movie_info.casts[0].character, '',
    'gateway cast character typo should be preserved by both stacks');

  await onBoth('/wrk2-api/movie/register', {
    form: { title: `bad_${title}` }
  }, 400);
});
