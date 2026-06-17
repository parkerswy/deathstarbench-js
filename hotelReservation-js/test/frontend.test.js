// Layer B - frontend HTTP end-to-end.
//
// Brings up the full stack in-process (all gRPC services + the Fastify
// frontend) backed by in-memory doubles seeded with the canonical data, then
// drives the 8 public endpoints over real HTTP. Pins param validation, the
// orchestration flow, message strings, the geoJSON shape ([lon, lat] order),
// and the subtle "reservation proceeds regardless of auth" behavior.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  FakeMongoClient,
  FakeRegistry,
  MemoryCache,
  getFreePort,
  seedAll,
  silentLogger,
  tracer
} from './helpers.js';

import { startGeoService } from '../src/services/geo/server.js';
import { startRateService } from '../src/services/rate/server.js';
import { startProfileService } from '../src/services/profile/server.js';
import { startSearchService } from '../src/services/search/server.js';
import { startRecommendationService } from '../src/services/recommendation/server.js';
import { startReservationService } from '../src/services/reservation/server.js';
import { startUserService } from '../src/services/user/server.js';
import { startReviewService } from '../src/services/review/server.js';
import { startAttractionsService } from '../src/services/attractions/server.js';
import { startFrontendService } from '../src/services/frontend/server.js';

// Seeded user 0: username "Cornell_30", password "0000000000".
const USER = 'Cornell_30';
const PASS = '0000000000';

let stack;

async function buildStack() {
  const registry = new FakeRegistry();
  const mongoClient = new FakeMongoClient();
  await seedAll(mongoClient);

  // Production runs a separate memcached per service (memcached-profile,
  // memcached-rate, memcached-review, memcached-reserve). Mirror that: a shared
  // cache would let services collide on the hotelId key namespace.
  const base = {
    logger: silentLogger,
    tracer,
    registry,
    mongoClient,
    port: 0,
    ipAddress: '127.0.0.1',
    knativeDns: ''
  };
  const withCache = () => ({ ...base, memcached: new MemoryCache() });

  const handles = [];
  handles.push(await startGeoService(base));
  handles.push(await startRateService(withCache()));
  handles.push(await startProfileService(withCache()));
  handles.push(await startRecommendationService(base));
  handles.push(await startReservationService(withCache()));
  handles.push(await startUserService(base));
  handles.push(await startReviewService(withCache()));
  handles.push(await startAttractionsService(base));
  handles.push(await startSearchService(base));

  const frontendPort = await getFreePort();
  const frontend = await startFrontendService({
    logger: silentLogger,
    registry,
    port: frontendPort,
    knativeDns: ''
  });
  handles.push(frontend);

  return {
    baseUrl: `http://127.0.0.1:${frontendPort}`,
    mongoClient,
    async shutdown() {
      for (const handle of handles.reverse()) {
        await handle.shutdown();
      }
    }
  };
}

before(async () => {
  stack = await buildStack();
});

after(async () => {
  await stack?.shutdown();
});

function get(path) {
  return fetch(`${stack.baseUrl}${path}`);
}

// ---------------------------------------------------------------------------
// /user
// ---------------------------------------------------------------------------

test('/user: 400 without creds, success/failure messages, CORS header', async () => {
  const missing = await get('/user');
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /Please specify username and password/);

  const ok = await get(`/user?username=${USER}&password=${PASS}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  assert.equal((await ok.json()).message, 'Login successfully!');

  const bad = await get(`/user?username=${USER}&password=wrong`);
  assert.equal(
    (await bad.json()).message,
    'Failed. Please check your username and password. '
  );
});

// ---------------------------------------------------------------------------
// /hotels (search)
// ---------------------------------------------------------------------------

test('/hotels: validates params and returns a geoJSON FeatureCollection with [lon, lat]', async () => {
  assert.equal((await get('/hotels?lat=37.7&lon=-122.4')).status, 400); // no dates
  assert.equal((await get('/hotels?inDate=2015-04-09&outDate=2015-04-10')).status, 400); // no loc

  const res = await get(
    '/hotels?inDate=2015-04-09&outDate=2015-04-10&lat=37.7867&lon=-122.4112'
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'FeatureCollection');
  assert.ok(Array.isArray(body.features) && body.features.length > 0);

  const feature = body.features.find((f) => f.id === '1') ?? body.features[0];
  assert.equal(feature.type, 'Feature');
  assert.ok('name' in feature.properties && 'phone_number' in feature.properties);
  assert.equal(feature.geometry.type, 'Point');
  assert.equal(feature.geometry.coordinates.length, 2);
  if (feature.id === '1') {
    // coordinates are [lon, lat] (note the order), float32-truncated.
    assert.ok(Math.abs(feature.geometry.coordinates[0] - -122.4112) < 1e-3);
    assert.ok(Math.abs(feature.geometry.coordinates[1] - 37.7867) < 1e-3);
  }
});

test('/hotels: filters hotels made unavailable by cold-cache reservation data', async () => {
  await stack.mongoClient.db('reservation-db').collection('reservation').insertOne({
    hotelId: '1',
    customerName: 'Full',
    inDate: '2015-04-12',
    outDate: '2015-04-13',
    number: 200
  });

  const res = await get(
    '/hotels?inDate=2015-04-12&outDate=2015-04-13&lat=37.7867&lon=-122.4112'
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.features));
  assert.equal(body.features.some((feature) => feature.id === '1'), false);
});

test('/hotels: empty search result returns an empty FeatureCollection', async () => {
  const res = await get(
    '/hotels?inDate=2015-04-16&outDate=2015-04-17&lat=0&lon=0'
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    type: 'FeatureCollection',
    features: []
  });
});

// ---------------------------------------------------------------------------
// /recommendations
// ---------------------------------------------------------------------------

test('/recommendations: validates require, returns geoJSON', async () => {
  assert.equal((await get('/recommendations?require=rate')).status, 400); // no loc
  assert.equal((await get('/recommendations?lat=37&lon=-122')).status, 400); // no require
  assert.equal(
    (await get('/recommendations?lat=37&lon=-122&require=bogus')).status,
    400
  );

  const res = await get('/recommendations?lat=37.7&lon=-122.4&require=rate');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'FeatureCollection');
  assert.ok(Array.isArray(body.features) && body.features.length > 0);
});

// ---------------------------------------------------------------------------
// /review (auth result is intentionally discarded)
// ---------------------------------------------------------------------------

test('/review: counts reviews and ignores the auth result', async () => {
  assert.equal((await get('/review?hotelId=1')).status, 400); // no creds
  assert.equal((await get(`/review?username=${USER}&password=${PASS}`)).status, 400); // no hotelId

  const ok = await get(`/review?username=${USER}&password=${PASS}&hotelId=1`);
  assert.equal((await ok.json()).message, 'Have reviews = 4');

  // Wrong password still returns the review count (CheckUser result discarded).
  const wrongCreds = await get(`/review?username=${USER}&password=nope&hotelId=1`);
  assert.equal((await wrongCreds.json()).message, 'Have reviews = 4');

  const none = await get(`/review?username=${USER}&password=${PASS}&hotelId=999`);
  assert.equal((await none.json()).message, 'Failed. No Reviews. ');
});

// ---------------------------------------------------------------------------
// /restaurants /museums /cinema
// ---------------------------------------------------------------------------

test('/restaurants /museums /cinema: counts and failure strings', async () => {
  assert.equal((await get('/restaurants?hotelId=1')).status, 400); // no creds

  const rest = await get(`/restaurants?username=${USER}&password=${PASS}&hotelId=1`);
  assert.match((await rest.json()).message, /^Have restaurants = [1-9]/);

  const mus = await get(`/museums?username=${USER}&password=${PASS}&hotelId=1`);
  assert.match((await mus.json()).message, /^Have museums = /);

  // No cinema data is seeded -> always the failure string.
  const cin = await get(`/cinema?username=${USER}&password=${PASS}&hotelId=1`);
  assert.equal((await cin.json()).message, 'Failed. No Cinemas. ');

  const noRest = await get(`/restaurants?username=${USER}&password=${PASS}&hotelId=999`);
  assert.equal((await noRest.json()).message, 'Failed. No Restaurants. ');

  const wrongCreds = await get(`/restaurants?username=${USER}&password=wrong&hotelId=1`);
  assert.match((await wrongCreds.json()).message, /^Have restaurants = [1-9]/);
});

// ---------------------------------------------------------------------------
// /reservation
// ---------------------------------------------------------------------------

test('/reservation: validates params (incl. date format)', async () => {
  assert.equal((await get('/reservation?hotelId=1')).status, 400); // no dates
  const badFmt = await get(
    '/reservation?inDate=2015-4-9&outDate=2015-04-10&hotelId=1&customerName=Bob&username=' +
      `${USER}&password=${PASS}`
  );
  assert.equal(badFmt.status, 400);
  assert.match(await badFmt.text(), /YYYY-MM-DD/);

  const noHotel = await get(
    `/reservation?inDate=2015-04-09&outDate=2015-04-10&customerName=Bob&username=${USER}&password=${PASS}`
  );
  assert.equal(noHotel.status, 400);

  const noCustomer = await get(
    `/reservation?inDate=2015-04-09&outDate=2015-04-10&hotelId=1&username=${USER}&password=${PASS}`
  );
  assert.equal(noCustomer.status, 400);

  const noCreds = await get(
    '/reservation?inDate=2015-04-09&outDate=2015-04-10&hotelId=1&customerName=Bob'
  );
  assert.equal(noCreds.status, 400);
});

test('/reservation: success message on a valid booking', async () => {
  const res = await get(
    `/reservation?inDate=2015-04-09&outDate=2015-04-10&hotelId=2&customerName=Bob&username=${USER}&password=${PASS}&number=1`
  );
  assert.equal((await res.json()).message, 'Reserve successfully!');
});

test('/reservation: missing number defaults to 0 and still writes a reservation row', async () => {
  const before = await stack.mongoClient
    .db('reservation-db')
    .collection('reservation')
    .find({ hotelId: '5' })
    .toArray();

  const res = await get(
    `/reservation?inDate=2015-04-14&outDate=2015-04-15&hotelId=5&customerName=DefaultRooms&username=${USER}&password=${PASS}`
  );
  assert.equal((await res.json()).message, 'Reserve successfully!');

  const afterDocs = await stack.mongoClient
    .db('reservation-db')
    .collection('reservation')
    .find({ hotelId: '5' })
    .toArray();
  assert.equal(afterDocs.length, before.length + 1);
  assert.equal(afterDocs.at(-1).number, 0);
});

test('/reservation: non-numeric number defaults to 0 and writes that row', async () => {
  const res = await get(
    `/reservation?inDate=2015-06-01&outDate=2015-06-02&hotelId=6&customerName=NonNumericRooms&username=${USER}&password=${PASS}&number=abc`
  );
  assert.equal((await res.json()).message, 'Reserve successfully!');

  const docs = await stack.mongoClient
    .db('reservation-db')
    .collection('reservation')
    .find({ hotelId: '6' })
    .toArray();
  const written = docs.find((doc) => doc.customerName === 'NonNumericRooms');
  assert.ok(written);
  assert.equal(written.number, 0);
});

test('/reservation: negative number is accepted and writes a negative reservation row', async () => {
  const res = await get(
    `/reservation?inDate=2015-06-03&outDate=2015-06-04&hotelId=7&customerName=NegativeRooms&username=${USER}&password=${PASS}&number=-2`
  );
  assert.equal((await res.json()).message, 'Reserve successfully!');

  const docs = await stack.mongoClient
    .db('reservation-db')
    .collection('reservation')
    .find({ hotelId: '7' })
    .toArray();
  const written = docs.find((doc) => doc.customerName === 'NegativeRooms');
  assert.ok(written);
  assert.equal(written.number, -2);
});

test('/reservation: non-positive stay range returns success without writing rows', async () => {
  const sameDay = await get(
    `/reservation?inDate=2015-06-05&outDate=2015-06-05&hotelId=8&customerName=ZeroNight&username=${USER}&password=${PASS}&number=1`
  );
  assert.equal((await sameDay.json()).message, 'Reserve successfully!');

  const backwards = await get(
    `/reservation?inDate=2015-06-07&outDate=2015-06-06&hotelId=8&customerName=BackwardsStay&username=${USER}&password=${PASS}&number=1`
  );
  assert.equal((await backwards.json()).message, 'Reserve successfully!');

  const docs = await stack.mongoClient
    .db('reservation-db')
    .collection('reservation')
    .find({ hotelId: '8' })
    .toArray();
  assert.equal(docs.some((doc) => doc.customerName === 'ZeroNight'), false);
  assert.equal(docs.some((doc) => doc.customerName === 'BackwardsStay'), false);
});

test('/reservation: wrong creds still books, but message stays the auth-failure string', async () => {
  const before = await stack.mongoClient
    .db('reservation-db')
    .collection('reservation')
    .find({ hotelId: '3' })
    .toArray();

  const res = await get(
    `/reservation?inDate=2015-04-09&outDate=2015-04-10&hotelId=3&customerName=Bob&username=${USER}&password=wrong&number=1`
  );
  // Auth failed -> message is the auth-failure string, NOT "Reserve successfully!"...
  assert.equal(
    (await res.json()).message,
    'Failed. Please check your username and password. '
  );

  // ... yet the reservation was actually written (matches Go: auth is not enforced).
  const afterDocs = await stack.mongoClient
    .db('reservation-db')
    .collection('reservation')
    .find({ hotelId: '3' })
    .toArray();
  assert.ok(afterDocs.length > before.length);
});

test('/reservation: sold-out booking returns the already-reserved message', async () => {
  await stack.mongoClient.db('reservation-db').collection('reservation').insertOne({
    hotelId: '4',
    customerName: 'Full',
    inDate: '2015-04-18',
    outDate: '2015-04-19',
    number: 200
  });

  const res = await get(
    `/reservation?inDate=2015-04-18&outDate=2015-04-19&hotelId=4&customerName=Bob&username=${USER}&password=${PASS}&number=1`
  );
  assert.equal((await res.json()).message, 'Failed. Already reserved. ');

  const docs = await stack.mongoClient
    .db('reservation-db')
    .collection('reservation')
    .find({ hotelId: '4' })
    .toArray();
  assert.equal(docs.filter((doc) => doc.customerName === 'Bob').length, 0);
});
