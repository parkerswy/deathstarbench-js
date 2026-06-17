// Layer D - differential test (the authoritative "bake both cakes" check).
//
// Drives the SAME requests against TWO live, full stacks (the original Go
// benchmark and this JS port) and asserts identical responses after
// normalizing the handful of fields that are inherently per-stack (feature
// ordering, which is non-deterministic on both because profile lookups fan out
// concurrently).
//
// The Go stack is the oracle: we compare the JS port's real end-to-end output
// (real gRPC wire, real Mongo/memcached) to the Go port's real output.
//
// Auto-skips when the URLs are unset so it never breaks `npm test`. Run it with:
//
//   DIFF_GO_URL=http://localhost:5000 \
//   DIFF_JS_URL=http://localhost:15000 \
//   node --test test/differential.test.js
//
// Bring both stacks up first (both seed identical data via their db loaders):
//
//   (cd ../hotelReservation && docker compose up -d)        # Go  -> :5000
//   # JS stack on :15000 via an override on the frontend port:
//   docker compose up -d                                    # JS port per its compose
//
// Both seed the same fixtures, so the same request sequence is directly comparable.

import test from 'node:test';
import assert from 'node:assert/strict';

const GO_URL = process.env.DIFF_GO_URL;
const JS_URL = process.env.DIFF_JS_URL;
const skip = (!GO_URL || !JS_URL) && 'set DIFF_GO_URL and DIFF_JS_URL to run';

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(base, path) {
  let lastError;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const res = await fetch(base + path);
      if (!RETRYABLE_STATUS.has(res.status)) {
        return res;
      }

      lastError = new Error(`GET ${path} on ${base} -> ${res.status}: ${await res.text()}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(500);
  }

  throw lastError;
}

async function getText(base, path) {
  const res = await fetchWithRetry(base, path);
  return { status: res.status, text: await res.text() };
}

async function getJson(base, path) {
  const res = await fetchWithRetry(base, path);
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`GET ${path} on ${base} -> ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

// geoJSON feature order is non-deterministic on both stacks (profile lookups
// fan out concurrently); compare the sorted set of features instead.
function normalizeGeo(geo) {
  assert.equal(geo.type, 'FeatureCollection');
  return (geo.features ?? [])
    .map((f) => ({
      id: String(f.id),
      name: f.properties?.name ?? '',
      phone_number: f.properties?.phone_number ?? '',
      // round float32 coordinates so the two stacks' encodings agree
      coordinates: (f.geometry?.coordinates ?? []).map((c) => Math.round(c * 1e4) / 1e4)
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function bothGeo(path) {
  const [go, js] = await Promise.all([getJson(GO_URL, path), getJson(JS_URL, path)]);
  assert.deepEqual(normalizeGeo(js), normalizeGeo(go), `geoJSON diverged for ${path}`);
  return normalizeGeo(js);
}

async function bothText(path) {
  const [go, js] = await Promise.all([getText(GO_URL, path), getText(JS_URL, path)]);
  assert.equal(js.status, go.status, `status diverged for ${path}`);
  assert.equal(js.text, go.text, `body diverged for ${path}`);
  return js;
}

test('differential: /user login messages match', { skip }, async () => {
  await bothText('/user?username=Cornell_30&password=0000000000');
  await bothText('/user?username=Cornell_30&password=wrong');
  await bothText('/user'); // 400 path
});

test('differential: /recommendations match across dis/rate/price', { skip }, async () => {
  for (const require of ['dis', 'rate', 'price']) {
    const features = await bothGeo(
      `/recommendations?lat=37.7867&lon=-122.4112&require=${require}`
    );
    assert.ok(features.length > 0, `expected recommendations for require=${require}`);
  }
  // invalid require -> 400 on both
  await bothText('/recommendations?lat=37.7867&lon=-122.4112&require=bogus');
});

// This also doubles as the cold-cache CheckAvailability capacity-parity check.
// /hotels -> search -> reservation.CheckAvailability(RoomNumber:1), so the
// returned set is filtered by availability. The capacity-warming paths differ
// between stacks: the JS port warms `{id}_cap` from Mongo unconditionally when a
// hotel is absent from the GetMulti result (server.js ~L129), whereas Go only
// builds its miss-key list when GetMulti returns memcache.ErrCacheMiss
// (server.go ~L244) -- and gomemcache's GetMulti does NOT return ErrCacheMiss
// for partial/empty misses. If that divergence is real, the two stacks' /hotels
// availability would disagree on a cold cache and this assertion would catch it.
// Run this against freshly-started stacks (cold memcached) to exercise it.
test('differential: /hotels search results match', { skip }, async () => {
  await bothGeo('/hotels?inDate=2015-04-09&outDate=2015-04-10&lat=37.7867&lon=-122.4112');
  // validation parity
  await bothText('/hotels?lat=37.7867&lon=-122.4112');
});

test('differential: /review, /restaurants, /museums, /cinema messages match', { skip }, async () => {
  const creds = 'username=Cornell_30&password=0000000000';
  await bothText(`/review?${creds}&hotelId=1`);
  await bothText(`/review?${creds}&hotelId=999`);
  await bothText(`/restaurants?${creds}&hotelId=1`);
  await bothText(`/museums?${creds}&hotelId=1`);
  await bothText(`/cinema?${creds}&hotelId=1`);
});

// NOTE: the booking cases below MUTATE state on both stacks (they write
// reservation rows). This whole test assumes both stacks start from identical
// fresh seeds and run this exact request sequence; re-running without resetting
// both DBs will accumulate rows and can drift. Cases that exceed capacity (the
// "sold-out" check) are non-mutating because neither stack inserts on rejection.
//
// These are RESPONSE-ONLY comparisons. The DB/cache side effects (a row is
// written even on wrong creds; missing `number` writes `number: 0`; sold-out
// writes nothing) are pinned in-process against the doubles in frontend.test.js;
// the live diff here only proves the HTTP responses agree with Go.
test('differential: /reservation validation, auth-failure, and success messages match', { skip }, async () => {
  const creds = 'username=Cornell_30&password=0000000000';

  // valid single-night booking
  await bothText(
    `/reservation?inDate=2015-04-20&outDate=2015-04-21&hotelId=2&customerName=DiffUser&${creds}&number=1`
  );
  // valid multi-night booking (two nights)
  await bothText(
    `/reservation?inDate=2015-05-01&outDate=2015-05-03&hotelId=6&customerName=DiffUser&${creds}&number=1`
  );
  // missing `number` -> frontend defaults to 0 (response parity)
  await bothText(
    `/reservation?inDate=2015-05-05&outDate=2015-05-06&hotelId=7&customerName=DiffUser&${creds}`
  );
  // non-numeric `number` also defaults to 0 through strconv.Atoi/parseInt parity
  await bothText(
    `/reservation?inDate=2015-05-07&outDate=2015-05-08&hotelId=7&customerName=DiffNonNumeric&${creds}&number=abc`
  );
  // negative room counts are accepted by the frontend and reservation service
  await bothText(
    `/reservation?inDate=2015-05-09&outDate=2015-05-10&hotelId=7&customerName=DiffNegative&${creds}&number=-2`
  );
  // non-positive stay ranges return success without writing per-night rows
  await bothText(
    `/reservation?inDate=2015-05-11&outDate=2015-05-11&hotelId=7&customerName=DiffZeroNight&${creds}&number=1`
  );
  await bothText(
    `/reservation?inDate=2015-05-13&outDate=2015-05-12&hotelId=7&customerName=DiffBackwards&${creds}&number=1`
  );
  // sold-out: request more rooms than any hotel's capacity -> "Already reserved"
  // (non-mutating: neither stack inserts when over capacity)
  await bothText(
    `/reservation?inDate=2015-06-01&outDate=2015-06-02&hotelId=8&customerName=DiffUser&${creds}&number=999`
  );

  // validation parity (non-mutating)
  await bothText('/reservation?hotelId=2&customerName=DiffUser&' + creds); // no dates -> 400
  await bothText(
    '/reservation?inDate=2015-4-20&outDate=2015-04-21&hotelId=2&customerName=DiffUser&' +
      creds
  ); // malformed inDate
  await bothText(
    `/reservation?inDate=2015-04-20&outDate=2015-04-21&customerName=DiffUser&${creds}&number=1`
  ); // missing hotelId
  await bothText(
    `/reservation?inDate=2015-04-20&outDate=2015-04-21&hotelId=2&${creds}&number=1`
  ); // missing customerName

  // wrong creds: message stays the auth-failure string on both (response-only;
  // the "row is still written" side effect is proven in frontend.test.js)
  await bothText(
    '/reservation?inDate=2015-04-20&outDate=2015-04-21&hotelId=2&customerName=DiffUser&' +
      'username=Cornell_30&password=wrong&number=1'
  );
});
