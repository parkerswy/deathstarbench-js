// Layer A - per-service behavioral parity.
//
// Each service is started in-process with in-memory Mongo/memcached doubles and
// driven through the real gRPC client path. Assertions pin the exact Go
// behavior: cache keys, the "query whole collection on miss" quirks, sort
// order, capacity gating, and the reservation key-shape divergence between
// MakeReservation and CheckAvailability.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  FakeMongoClient,
  FakeRegistry,
  MemoryCache,
  connectClient,
  silentLogger,
  tracer
} from './helpers.js';

import { createUnaryHandler, startGrpcServer } from '../src/lib/grpc.js';
import { loadProto } from '../src/lib/loadProto.js';
import { startGeoService } from '../src/services/geo/server.js';
import { startRateService } from '../src/services/rate/server.js';
import { startProfileService } from '../src/services/profile/server.js';
import { startSearchService } from '../src/services/search/server.js';
import { startRecommendationService } from '../src/services/recommendation/server.js';
import { startReservationService } from '../src/services/reservation/server.js';
import { startUserService } from '../src/services/user/server.js';
import { startReviewService } from '../src/services/review/server.js';
import { startAttractionsService } from '../src/services/attractions/server.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const approx = (a, b, eps = 1e-4) => Math.abs(a - b) < eps;

async function startOne(startFn, serviceName, deps = {}) {
  const registry = deps.registry ?? new FakeRegistry();
  const mongoClient = deps.mongoClient ?? new FakeMongoClient();
  const memcached = deps.memcached ?? new MemoryCache();
  const handle = await startFn({
    logger: silentLogger,
    tracer,
    registry,
    mongoClient,
    memcached,
    port: 0,
    ipAddress: '127.0.0.1',
    knativeDns: ''
  });
  const client = await connectClient(registry, serviceName);
  return {
    registry,
    mongoClient,
    memcached,
    handle,
    client,
    async stop() {
      client.close();
      await handle.shutdown();
    }
  };
}

async function startStubService(registry, serviceName, protoName, serviceType, handlers) {
  const proto = loadProto(protoName);
  return startGrpcServer({
    port: 0,
    serviceName,
    ipAddress: '127.0.0.1',
    registry,
    addServices(server) {
      server.addService(proto[serviceType].service, handlers);
    }
  });
}

// ---------------------------------------------------------------------------
// geo.Nearby
// ---------------------------------------------------------------------------

test('geo.Nearby: returns the 5 nearest within 10km, distance-ordered', async () => {
  const mongoClient = new FakeMongoClient();
  const geo = mongoClient.db('geo-db').collection('geo');
  // points at lat 37.0 + k*0.01 (~1.11km per step from the query origin),
  // inserted out of order; one far point (~22km) must be excluded.
  await geo.insertMany([
    { hotelId: 'p3', lat: 37.03, lon: -122.0 },
    { hotelId: 'p0', lat: 37.0, lon: -122.0 },
    { hotelId: 'far', lat: 37.2, lon: -122.0 },
    { hotelId: 'p4', lat: 37.04, lon: -122.0 },
    { hotelId: 'p1', lat: 37.01, lon: -122.0 },
    { hotelId: 'p6', lat: 37.06, lon: -122.0 },
    { hotelId: 'p2', lat: 37.02, lon: -122.0 },
    { hotelId: 'p5', lat: 37.05, lon: -122.0 }
  ]);

  const svc = await startOne(startGeoService, 'srv-geo', { mongoClient });
  try {
    const res = await svc.client.call('Nearby', { lat: 37.0, lon: -122.0 });
    assert.deepEqual(res.hotelIds, ['p0', 'p1', 'p2', 'p3', 'p4']);

    const empty = await svc.client.call('Nearby', { lat: 0, lon: 0 });
    assert.deepEqual(empty.hotelIds ?? [], []);
  } finally {
    await svc.stop();
  }
});

// ---------------------------------------------------------------------------
// rate.GetRates
// ---------------------------------------------------------------------------

test('rate.GetRates: cache hit parses newline-delimited JSON and skips Mongo', async () => {
  const mongoClient = new FakeMongoClient();
  // A plan that must NOT appear (proves Mongo is untouched on a full cache hit).
  await mongoClient
    .db('rate-db')
    .collection('inventory')
    .insertOne({ hotelId: 'zzz', code: 'RACK', roomType: { totalRate: 999 } });
  const memcached = new MemoryCache();
  memcached.seed(
    'h1',
    `${JSON.stringify({ hotelId: 'h1', code: 'RACK', roomType: { totalRate: 50 } })}\n`
  );

  const svc = await startOne(startRateService, 'srv-rate', { mongoClient, memcached });
  try {
    const res = await svc.client.call('GetRates', { hotelIds: ['h1'] });
    assert.equal(res.ratePlans.length, 1);
    assert.equal(res.ratePlans[0].hotelId, 'h1');
  } finally {
    await svc.stop();
  }
});

test('rate.GetRates: cache miss queries the WHOLE inventory, sorts desc by totalRate, caches it', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient.db('rate-db').collection('inventory').insertMany([
    { hotelId: '1', code: 'RACK', roomType: { totalRate: 100 } },
    { hotelId: '2', code: 'RACK', roomType: { totalRate: 300 } },
    { hotelId: '3', code: 'RACK', roomType: { totalRate: 200 } }
  ]);

  const svc = await startOne(startRateService, 'srv-rate', { mongoClient });
  try {
    // Request a single hotel: the Go quirk returns the entire inventory.
    const res = await svc.client.call('GetRates', { hotelIds: ['1'] });
    assert.deepEqual(
      res.ratePlans.map((p) => p.hotelId),
      ['2', '3', '1'] // sorted by totalRate desc: 300, 200, 100
    );

    await tick();
    const cached = svc.memcached.values.get('1');
    assert.ok(cached, 'inventory cached under the requested hotelId');
    assert.equal(cached.split('\n').filter((l) => l.length).length, 3);
  } finally {
    await svc.stop();
  }
});

test('rate.GetRates: multiple missing hotels each pull the whole inventory (duplication quirk)', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient
    .db('rate-db')
    .collection('inventory')
    .insertOne({ hotelId: 'x', code: 'RACK', roomType: { totalRate: 10 } });

  const svc = await startOne(startRateService, 'srv-rate', { mongoClient });
  try {
    const res = await svc.client.call('GetRates', { hotelIds: ['a', 'b'] });
    // 2 missing hotels x 1-plan inventory -> the same plan twice (matches Go).
    assert.equal(res.ratePlans.length, 2);
    assert.deepEqual(res.ratePlans.map((p) => p.hotelId), ['x', 'x']);
  } finally {
    await svc.stop();
  }
});

test('rate.GetRates: mixed cache hit and miss combines cached plans with fetched inventory', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient.db('rate-db').collection('inventory').insertMany([
    { hotelId: 'fresh-high', code: 'RACK', roomType: { totalRate: 200 } },
    { hotelId: 'fresh-low', code: 'RACK', roomType: { totalRate: 50 } }
  ]);
  const memcached = new MemoryCache();
  memcached.seed(
    'cached',
    `${JSON.stringify({ hotelId: 'cached', code: 'RACK', roomType: { totalRate: 300 } })}\n`
  );

  const svc = await startOne(startRateService, 'srv-rate', { mongoClient, memcached });
  try {
    const res = await svc.client.call('GetRates', { hotelIds: ['cached', 'missing'] });
    assert.deepEqual(
      res.ratePlans.map((p) => p.hotelId),
      ['cached', 'fresh-high', 'fresh-low']
    );

    await tick();
    assert.ok(svc.memcached.values.get('missing')?.includes('"hotelId":"fresh-high"'));
    assert.deepEqual(
      svc.memcached.sets.map(([key]) => key),
      ['missing']
    );
  } finally {
    await svc.stop();
  }
});

test('rate.GetRates: empty hotelIds returns no plans and does not write cache', async () => {
  const svc = await startOne(startRateService, 'srv-rate', {});
  try {
    const res = await svc.client.call('GetRates', { hotelIds: [] });
    assert.deepEqual(res.ratePlans ?? [], []);
    assert.equal(svc.memcached.sets.length, 0);
  } finally {
    await svc.stop();
  }
});

// ---------------------------------------------------------------------------
// profile.GetProfiles
// ---------------------------------------------------------------------------

test('profile.GetProfiles: Mongo miss reads {id} and caches JSON; cache hit skips Mongo', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient.db('profile-db').collection('hotels').insertOne({
    id: '1',
    name: 'Clift Hotel',
    phoneNumber: '(415) 775-4700',
    address: { lat: 37.7867, lon: -122.4112 }
  });

  const svc = await startOne(startProfileService, 'srv-profile', { mongoClient });
  try {
    const miss = await svc.client.call('GetProfiles', { hotelIds: ['1'], locale: 'en' });
    assert.equal(miss.hotels.length, 1);
    assert.equal(miss.hotels[0].name, 'Clift Hotel');

    await tick();
    assert.ok(svc.memcached.values.get('1'), 'profile cached under hotelId');

    // Mutate Mongo; a second call must serve the cached copy (no re-read).
    svc.mongoClient.db('profile-db').collection('hotels').docs[0].name = 'CHANGED';
    const hit = await svc.client.call('GetProfiles', { hotelIds: ['1'], locale: 'en' });
    assert.equal(hit.hotels[0].name, 'Clift Hotel');
  } finally {
    await svc.stop();
  }
});

test('profile.GetProfiles: locale is accepted but does not change output', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient
    .db('profile-db')
    .collection('hotels')
    .insertOne({ id: '1', name: 'Clift Hotel', address: { lat: 1, lon: 2 } });

  const svc = await startOne(startProfileService, 'srv-profile', { mongoClient });
  try {
    const en = await svc.client.call('GetProfiles', { hotelIds: ['1'], locale: 'en' });
    const es = await svc.client.call('GetProfiles', { hotelIds: ['1'], locale: 'es' });
    assert.deepEqual(en.hotels, es.hotels);
  } finally {
    await svc.stop();
  }
});

test('profile.GetProfiles: cache hits are returned before Mongo misses', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient
    .db('profile-db')
    .collection('hotels')
    .insertOne({ id: 'miss', name: 'Mongo Hotel', address: { lat: 1, lon: 2 } });
  const memcached = new MemoryCache();
  memcached.seed('hit', JSON.stringify({ id: 'hit', name: 'Cached Hotel' }));

  const svc = await startOne(startProfileService, 'srv-profile', { mongoClient, memcached });
  try {
    const res = await svc.client.call('GetProfiles', {
      hotelIds: ['miss', 'hit'],
      locale: 'en'
    });
    assert.deepEqual(
      res.hotels.map((hotel) => hotel.id),
      ['hit', 'miss']
    );
  } finally {
    await svc.stop();
  }
});

// ---------------------------------------------------------------------------
// recommendation.GetRecommendations
// ---------------------------------------------------------------------------

test('recommendation.GetRecommendations: dis/rate/price modes, ties, and invalid require', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient.db('recommendation-db').collection('recommendation').insertMany([
    { hotelId: '1', lat: 37.0, lon: -122.0, rate: 100, price: 50 },
    { hotelId: '2', lat: 37.1, lon: -122.0, rate: 200, price: 50 },
    { hotelId: '3', lat: 38.0, lon: -122.0, rate: 150, price: 80 }
  ]);

  const svc = await startOne(startRecommendationService, 'srv-recommendation', {
    mongoClient
  });
  try {
    const byRate = await svc.client.call('GetRecommendations', {
      require: 'rate',
      lat: 0,
      lon: 0
    });
    assert.deepEqual(byRate.HotelIds, ['2']); // max rate 200

    const byPrice = await svc.client.call('GetRecommendations', {
      require: 'price',
      lat: 0,
      lon: 0
    });
    assert.deepEqual(byPrice.HotelIds, ['1', '2']); // min price 50, tie -> both

    const byDis = await svc.client.call('GetRecommendations', {
      require: 'dis',
      lat: 37.0,
      lon: -122.0
    });
    assert.deepEqual(byDis.HotelIds, ['1']); // distance 0

    const invalid = await svc.client.call('GetRecommendations', {
      require: 'bogus',
      lat: 0,
      lon: 0
    });
    assert.deepEqual(invalid.HotelIds ?? [], []);
  } finally {
    await svc.stop();
  }
});

// ---------------------------------------------------------------------------
// reservation.MakeReservation / CheckAvailability
// ---------------------------------------------------------------------------

test('reservation.MakeReservation: success writes per-night counts, cap cache, and one doc per night', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient
    .db('reservation-db')
    .collection('number')
    .insertOne({ hotelId: '1', numberOfRoom: 200 });

  const svc = await startOne(startReservationService, 'srv-reservation', { mongoClient });
  try {
    const res = await svc.client.call('MakeReservation', {
      customerName: 'Bob',
      hotelId: ['1'],
      inDate: '2015-04-09',
      outDate: '2015-04-11',
      roomNumber: 2
    });
    assert.deepEqual(res.hotelId, ['1']);

    // Two nights inserted: 09->10 and 10->11.
    const docs = await svc.mongoClient
      .db('reservation-db')
      .collection('reservation')
      .find({ hotelId: '1' })
      .toArray();
    assert.equal(docs.length, 2);
    assert.deepEqual(
      docs.map((d) => [d.inDate, d.outDate, d.number]),
      [['2015-04-09', '2015-04-10', 2], ['2015-04-10', '2015-04-11', 2]]
    );

    // Date-count keys use ${hotel}_${date}_${date} (same date twice).
    assert.equal(svc.memcached.values.get('1_2015-04-10_2015-04-10'), '2');
    assert.equal(svc.memcached.values.get('1_2015-04-11_2015-04-11'), '2');
    // Capacity warmed from Mongo on miss.
    assert.equal(svc.memcached.values.get('1_cap'), '200');
  } finally {
    await svc.stop();
  }
});

test('reservation.MakeReservation: uses only the first hotelId and ignores the rest', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient
    .db('reservation-db')
    .collection('number')
    .insertMany([
      { hotelId: '1', numberOfRoom: 200 },
      { hotelId: '2', numberOfRoom: 200 },
      { hotelId: '3', numberOfRoom: 200 }
    ]);

  const svc = await startOne(startReservationService, 'srv-reservation', { mongoClient });
  try {
    const res = await svc.client.call('MakeReservation', {
      customerName: 'Bob',
      hotelId: ['1', '2', '3'],
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomNumber: 2
    });
    // Go reads hotelId := req.HotelId[0]; the rest are ignored entirely.
    assert.deepEqual(res.hotelId, ['1']);

    const docs = await svc.mongoClient
      .db('reservation-db')
      .collection('reservation')
      .find({})
      .toArray();
    assert.deepEqual(docs.map((d) => d.hotelId), ['1']);

    // Only hotel 1's cache keys are ever written; 2 and 3 are untouched.
    assert.ok(svc.memcached.sets.every(([key]) => key.startsWith('1_')));
    assert.equal(svc.memcached.values.has('2_cap'), false);
    assert.equal(svc.memcached.values.has('3_cap'), false);
  } finally {
    await svc.stop();
  }
});

test('reservation.MakeReservation: rejects over-capacity with empty result and no inserts', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient
    .db('reservation-db')
    .collection('number')
    .insertOne({ hotelId: '1', numberOfRoom: 5 });

  const svc = await startOne(startReservationService, 'srv-reservation', { mongoClient });
  try {
    const res = await svc.client.call('MakeReservation', {
      customerName: 'Bob',
      hotelId: ['1'],
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomNumber: 10
    });
    assert.deepEqual(res.hotelId ?? [], []);

    const docs = await svc.mongoClient
      .db('reservation-db')
      .collection('reservation')
      .find({})
      .toArray();
    assert.equal(docs.length, 0);
    // Date-count updates were never flushed (only the cap cache was warmed).
    assert.equal(svc.memcached.values.has('1_2015-04-10_2015-04-10'), false);
  } finally {
    await svc.stop();
  }
});

test('reservation.MakeReservation: cache-hit count and capacity path updates cached count', async () => {
  const mongoClient = new FakeMongoClient();
  const memcached = new MemoryCache();
  memcached.seed('7_cap', '10');
  memcached.seed('7_2015-04-10_2015-04-10', '3');

  const svc = await startOne(startReservationService, 'srv-reservation', {
    mongoClient,
    memcached
  });
  try {
    const res = await svc.client.call('MakeReservation', {
      customerName: 'CacheHit',
      hotelId: ['7'],
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomNumber: 2
    });
    assert.deepEqual(res.hotelId, ['7']);
    assert.equal(svc.memcached.values.get('7_2015-04-10_2015-04-10'), '5');
    assert.equal(svc.memcached.values.get('7_cap'), '10');
    assert.deepEqual(svc.memcached.sets, [['7_2015-04-10_2015-04-10', '5']]);

    const docs = await svc.mongoClient
      .db('reservation-db')
      .collection('reservation')
      .find({ hotelId: '7' })
      .toArray();
    assert.deepEqual(
      docs.map((d) => [d.customerName, d.inDate, d.outDate, d.number]),
      [['CacheHit', '2015-04-09', '2015-04-10', 2]]
    );
  } finally {
    await svc.stop();
  }
});

test('reservation.MakeReservation: later-night rejection does not flush earlier cache updates', async () => {
  const memcached = new MemoryCache();
  memcached.seed('9_cap', '5');
  memcached.seed('9_2015-04-10_2015-04-10', '0');
  memcached.seed('9_2015-04-11_2015-04-11', '3');
  memcached.seed('9_2015-04-12_2015-04-12', '4');

  const svc = await startOne(startReservationService, 'srv-reservation', { memcached });
  try {
    const res = await svc.client.call('MakeReservation', {
      customerName: 'LateReject',
      hotelId: ['9'],
      inDate: '2015-04-09',
      outDate: '2015-04-12',
      roomNumber: 2
    });
    assert.deepEqual(res.hotelId ?? [], []);
    assert.equal(svc.memcached.values.get('9_2015-04-10_2015-04-10'), '0');
    assert.equal(svc.memcached.values.get('9_2015-04-11_2015-04-11'), '3');
    assert.equal(svc.memcached.values.get('9_2015-04-12_2015-04-12'), '4');
    assert.deepEqual(svc.memcached.sets, []);

    const docs = await svc.mongoClient
      .db('reservation-db')
      .collection('reservation')
      .find({})
      .toArray();
    assert.equal(docs.length, 0);
  } finally {
    await svc.stop();
  }
});

test('reservation.MakeReservation: non-positive stay ranges succeed without writes', async () => {
  const svc = await startOne(startReservationService, 'srv-reservation', {});
  try {
    const sameDay = await svc.client.call('MakeReservation', {
      customerName: 'ZeroNight',
      hotelId: ['zero'],
      inDate: '2015-04-10',
      outDate: '2015-04-10',
      roomNumber: 1
    });
    assert.deepEqual(sameDay.hotelId, ['zero']);

    const backwards = await svc.client.call('MakeReservation', {
      customerName: 'Backwards',
      hotelId: ['backwards'],
      inDate: '2015-04-11',
      outDate: '2015-04-10',
      roomNumber: 1
    });
    assert.deepEqual(backwards.hotelId, ['backwards']);

    const docs = await svc.mongoClient
      .db('reservation-db')
      .collection('reservation')
      .find({})
      .toArray();
    assert.equal(docs.length, 0);
    assert.deepEqual(svc.memcached.sets, []);
  } finally {
    await svc.stop();
  }
});

test('reservation.MakeReservation: negative roomNumber writes negative counts', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient
    .db('reservation-db')
    .collection('number')
    .insertOne({ hotelId: 'neg', numberOfRoom: 1 });

  const svc = await startOne(startReservationService, 'srv-reservation', { mongoClient });
  try {
    const res = await svc.client.call('MakeReservation', {
      customerName: 'NegativeRooms',
      hotelId: ['neg'],
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomNumber: -2
    });
    assert.deepEqual(res.hotelId, ['neg']);
    assert.equal(svc.memcached.values.get('neg_cap'), '1');
    assert.equal(svc.memcached.values.get('neg_2015-04-10_2015-04-10'), '-2');

    const docs = await svc.mongoClient
      .db('reservation-db')
      .collection('reservation')
      .find({ hotelId: 'neg' })
      .toArray();
    assert.deepEqual(
      docs.map((d) => [d.customerName, d.inDate, d.outDate, d.number]),
      [['NegativeRooms', '2015-04-09', '2015-04-10', -2]]
    );
  } finally {
    await svc.stop();
  }
});

test('reservation.MakeReservation: concurrent cold-cache requests can oversell capacity', async () => {
  class BarrierCache extends MemoryCache {
    constructor() {
      super();
      this.waiting = 0;
      this.releaseDateReads = null;
      this.dateReadsReady = new Promise((resolve) => {
        this.releaseDateReads = resolve;
      });
    }

    async get(key) {
      if (key === 'race_2015-04-10_2015-04-10') {
        this.waiting += 1;
        if (this.waiting === 2) {
          this.releaseDateReads();
        }
        await this.dateReadsReady;
      }
      return super.get(key);
    }
  }

  const mongoClient = new FakeMongoClient();
  await mongoClient
    .db('reservation-db')
    .collection('number')
    .insertOne({ hotelId: 'race', numberOfRoom: 1 });
  const memcached = new BarrierCache();

  const svc = await startOne(startReservationService, 'srv-reservation', {
    mongoClient,
    memcached
  });
  try {
    const request = (customerName) =>
      svc.client.call('MakeReservation', {
        customerName,
        hotelId: ['race'],
        inDate: '2015-04-09',
        outDate: '2015-04-10',
        roomNumber: 1
      });

    const [first, second] = await Promise.all([
      request('ConcurrentA'),
      request('ConcurrentB')
    ]);
    assert.deepEqual(first.hotelId, ['race']);
    assert.deepEqual(second.hotelId, ['race']);

    const docs = await svc.mongoClient
      .db('reservation-db')
      .collection('reservation')
      .find({ hotelId: 'race' })
      .toArray();
    assert.equal(docs.length, 2);
    assert.equal(docs.reduce((sum, doc) => sum + doc.number, 0), 2);
    assert.equal(svc.memcached.values.get('race_2015-04-10_2015-04-10'), '1');
  } finally {
    await svc.stop();
  }
});

test('reservation.CheckAvailability: cold caches read Mongo capacities and return available hotels', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient.db('reservation-db').collection('number').insertMany([
    { hotelId: '1', numberOfRoom: 10 },
    { hotelId: '2', numberOfRoom: 10 }
  ]);
  const svc = await startOne(startReservationService, 'srv-reservation', { mongoClient });
  try {
    const res = await svc.client.call('CheckAvailability', {
      customerName: '',
      hotelId: ['1', '2'],
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomNumber: 1
    });
    assert.deepEqual([...(res.hotelId ?? [])].sort(), ['1', '2']);
    assert.equal(svc.memcached.values.get('1_cap'), '10');
    assert.equal(svc.memcached.values.get('2_cap'), '10');
  } finally {
    await svc.stop();
  }
});

test('reservation.CheckAvailability: reads per-night keys shaped ${hotel}_${outDate}_${outDate}', async () => {
  // The key shape differs from MakeReservation (which uses the in/out dates);
  // CheckAvailability repeats the out-date. Assert on the keys actually read so
  // the shape is pinned independent of the (separately tracked) capacity logic.
  const svc = await startOne(startReservationService, 'srv-reservation', {});
  try {
    await svc.client.call('CheckAvailability', {
      customerName: '',
      hotelId: ['1'],
      inDate: '2015-04-09',
      outDate: '2015-04-11',
      roomNumber: 1
    });
    const requested = svc.memcached.getMultiCalls.flat();
    assert.ok(requested.includes('1_cap'), 'reads the capacity key');
    assert.ok(requested.includes('1_2015-04-10_2015-04-10'), 'night 1 double-outDate key');
    assert.ok(requested.includes('1_2015-04-11_2015-04-11'), 'night 2 double-outDate key');
  } finally {
    await svc.stop();
  }
});

test('reservation.CheckAvailability: cold-cache Mongo fallback rejects full hotels and warms counts', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient.db('reservation-db').collection('number').insertMany([
    { hotelId: '1', numberOfRoom: 10 },
    { hotelId: '2', numberOfRoom: 10 }
  ]);
  // Hotel 1 is full for the night; hotel 2 has no reservations.
  await mongoClient.db('reservation-db').collection('reservation').insertOne({
    hotelId: '1',
    customerName: 'X',
    inDate: '2015-04-09',
    outDate: '2015-04-10',
    number: 10
  });

  const svc = await startOne(startReservationService, 'srv-reservation', { mongoClient });
  try {
    const res = await svc.client.call('CheckAvailability', {
      customerName: '',
      hotelId: ['1', '2'],
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomNumber: 1
    });
    assert.deepEqual(res.hotelId ?? [], ['2']);
    assert.equal(svc.memcached.values.get('1_2015-04-10_2015-04-10'), '10');
    assert.equal(svc.memcached.values.get('2_2015-04-10_2015-04-10'), '0');
  } finally {
    await svc.stop();
  }
});

test('reservation.CheckAvailability: rejects a hotel when a later night is full', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient
    .db('reservation-db')
    .collection('number')
    .insertOne({ hotelId: '1', numberOfRoom: 5 });
  await mongoClient.db('reservation-db').collection('reservation').insertMany([
    {
      hotelId: '1',
      customerName: 'EarlierOk',
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      number: 1
    },
    {
      hotelId: '1',
      customerName: 'LaterFull',
      inDate: '2015-04-10',
      outDate: '2015-04-11',
      number: 5
    }
  ]);

  const svc = await startOne(startReservationService, 'srv-reservation', { mongoClient });
  try {
    const res = await svc.client.call('CheckAvailability', {
      customerName: '',
      hotelId: ['1'],
      inDate: '2015-04-09',
      outDate: '2015-04-11',
      roomNumber: 1
    });
    assert.deepEqual(res.hotelId ?? [], []);
    assert.equal(svc.memcached.values.get('1_2015-04-10_2015-04-10'), '1');
    assert.equal(svc.memcached.values.get('1_2015-04-11_2015-04-11'), '5');
  } finally {
    await svc.stop();
  }
});

test('reservation.CheckAvailability: full cache hits still use cached capacity by hotel id', async () => {
  const memcached = new MemoryCache();
  memcached.seed('1_cap', '10');
  memcached.seed('1_2015-04-10_2015-04-10', '9');

  const svc = await startOne(startReservationService, 'srv-reservation', { memcached });
  try {
    const oneMore = await svc.client.call('CheckAvailability', {
      customerName: '',
      hotelId: ['1'],
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomNumber: 1
    });
    assert.deepEqual(oneMore.hotelId ?? [], ['1']);

    const tooMany = await svc.client.call('CheckAvailability', {
      customerName: '',
      hotelId: ['1'],
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomNumber: 2
    });
    assert.deepEqual(tooMany.hotelId ?? [], []);
  } finally {
    await svc.stop();
  }
});

// ---------------------------------------------------------------------------
// user.CheckUser
// ---------------------------------------------------------------------------

test('user.CheckUser: sha256 password match, wrong password, and unknown user', async () => {
  const mongoClient = new FakeMongoClient();
  const hash = crypto.createHash('sha256').update('secret').digest('hex');
  await mongoClient
    .db('user-db')
    .collection('user')
    .insertOne({ username: 'alice', password: hash });

  const svc = await startOne(startUserService, 'srv-user', { mongoClient });
  try {
    assert.equal((await svc.client.call('CheckUser', { username: 'alice', password: 'secret' })).correct, true);
    assert.equal((await svc.client.call('CheckUser', { username: 'alice', password: 'wrong' })).correct, false);
    assert.equal((await svc.client.call('CheckUser', { username: 'ghost', password: 'secret' })).correct, false);
  } finally {
    await svc.stop();
  }
});

// ---------------------------------------------------------------------------
// review.GetReviews
// ---------------------------------------------------------------------------

test('review.GetReviews: Mongo miss maps fields and caches; cache hit serves JSON', async () => {
  const mongoClient = new FakeMongoClient();
  await mongoClient.db('review-db').collection('reviews').insertMany([
    { reviewId: '1', hotelId: '1', name: 'P1', rating: 3.4, description: 'd1', images: { url: 'u', default: false } },
    { reviewId: '2', hotelId: '1', name: 'P2', rating: 4.4, description: 'd2', images: { url: 'u', default: false } }
  ]);

  const svc = await startOne(startReviewService, 'srv-review', { mongoClient });
  try {
    const res = await svc.client.call('GetReviews', { hotelId: '1' });
    assert.equal(res.reviews.length, 2);
    assert.equal(res.reviews[0].reviewId, '1');
    assert.equal(res.reviews[0].name, 'P1');
    assert.ok(approx(res.reviews[0].rating, 3.4));
    assert.deepEqual(res.reviews[0].images, { url: 'u', default: false });

    await tick();
    assert.ok(svc.memcached.values.get('1'), 'reviews cached under hotelId');

    svc.mongoClient.db('review-db').collection('reviews').docs = [];
    const hit = await svc.client.call('GetReviews', { hotelId: '1' });
    assert.equal(hit.reviews.length, 2);
    assert.equal(hit.reviews[1].reviewId, '2');

    // empty hotel -> [] and cached as '[]'
    const empty = await svc.client.call('GetReviews', { hotelId: '999' });
    assert.deepEqual(empty.reviews ?? [], []);
  } finally {
    await svc.stop();
  }
});

// ---------------------------------------------------------------------------
// attractions.NearbyRest / NearbyMus / NearbyCinema
// ---------------------------------------------------------------------------

test('attractions: NearbyRest and NearbyMus rank by distance; NearbyCinema is empty', async () => {
  const mongoClient = new FakeMongoClient();
  const db = mongoClient.db('attractions-db');
  await db.collection('hotels').insertOne({ hotelId: '1', lat: 37.7867, lon: -122.4112 });
  await db.collection('restaurants').insertMany([
    { restaurantId: 'r-here', lat: 37.7867, lon: -122.4112 }, // distance 0
    { restaurantId: 'r-near', lat: 37.7877, lon: -122.4112 }, // ~0.11km
    { restaurantId: 'r-far', lat: 38.5, lon: -122.4112 } // ~80km, excluded
  ]);
  await db.collection('museums').insertMany([
    { museumId: 'm-here', lat: 37.7867, lon: -122.4112 },
    { museumId: 'm-near', lat: 37.7877, lon: -122.4112 },
    { museumId: 'm-far', lat: 38.5, lon: -122.4112 }
  ]);

  const svc = await startOne(startAttractionsService, 'srv-attractions', { mongoClient });
  try {
    const rest = await svc.client.call('NearbyRest', { hotelId: '1' });
    assert.equal(rest.attractionIds[0], 'r-here');
    assert.ok(!rest.attractionIds.includes('r-far'));
    assert.ok(rest.attractionIds.length <= 5);

    const mus = await svc.client.call('NearbyMus', { hotelId: '1' });
    assert.deepEqual(mus.attractionIds, ['m-here', 'm-near']);

    // No cinemas collection seeded -> empty (matches Go).
    const cinema = await svc.client.call('NearbyCinema', { hotelId: '1' });
    assert.deepEqual(cinema.attractionIds ?? [], []);

    // Unknown hotel -> empty.
    const missing = await svc.client.call('NearbyRest', { hotelId: '999' });
    assert.deepEqual(missing.attractionIds ?? [], []);
  } finally {
    await svc.stop();
  }
});

test('attractions: hotel coordinate lookup uses the last matching hotel document', async () => {
  const mongoClient = new FakeMongoClient();
  const db = mongoClient.db('attractions-db');
  await db.collection('hotels').insertMany([
    { hotelId: 'dup', lat: 0, lon: 0 },
    { hotelId: 'dup', lat: 37.7867, lon: -122.4112 }
  ]);
  await db.collection('restaurants').insertMany([
    { restaurantId: 'first-coord', lat: 0, lon: 0 },
    { restaurantId: 'last-coord', lat: 37.7867, lon: -122.4112 }
  ]);

  const svc = await startOne(startAttractionsService, 'srv-attractions', { mongoClient });
  try {
    const rest = await svc.client.call('NearbyRest', { hotelId: 'dup' });
    assert.deepEqual(rest.attractionIds, ['last-coord']);
  } finally {
    await svc.stop();
  }
});

// ---------------------------------------------------------------------------
// search.Nearby (geo -> rate orchestration)
// ---------------------------------------------------------------------------

test('search.Nearby: returns hotelIds in rate-plan (totalRate desc) order', async () => {
  const registry = new FakeRegistry();
  const mongoClient = new FakeMongoClient();
  const memcached = new MemoryCache();

  // Two hotels within range; pre-seed the rate cache so each hotel contributes
  // exactly its own plan (avoids the whole-inventory miss duplication).
  await mongoClient.db('geo-db').collection('geo').insertMany([
    { hotelId: '1', lat: 37.0, lon: -122.0 },
    { hotelId: '2', lat: 37.01, lon: -122.0 }
  ]);
  memcached.seed(
    '1',
    `${JSON.stringify({ hotelId: '1', code: 'RACK', roomType: { totalRate: 100 } })}\n`
  );
  memcached.seed(
    '2',
    `${JSON.stringify({ hotelId: '2', code: 'RACK', roomType: { totalRate: 200 } })}\n`
  );

  const geo = await startGeoService({
    registry, mongoClient, memcached, logger: silentLogger, tracer, port: 0, ipAddress: '127.0.0.1'
  });
  const rate = await startRateService({
    registry, mongoClient, memcached, logger: silentLogger, tracer, port: 0, ipAddress: '127.0.0.1'
  });
  const search = await startSearchService({
    registry, logger: silentLogger, tracer, port: 0, ipAddress: '127.0.0.1', knativeDns: ''
  });
  const client = await connectClient(registry, 'srv-search');

  try {
    const res = await client.call('Nearby', {
      lat: 37.0,
      lon: -122.0,
      inDate: '2015-04-09',
      outDate: '2015-04-10'
    });
    // geo -> ['1','2']; rate sorts desc by totalRate -> ['2','1'].
    assert.deepEqual(res.hotelIds, ['2', '1']);
  } finally {
    client.close();
    await search.shutdown();
    await rate.shutdown();
    await geo.shutdown();
  }
});

test('search.Nearby: empty geo result returns empty hotelIds', async () => {
  const registry = new FakeRegistry();
  const mongoClient = new FakeMongoClient();
  const memcached = new MemoryCache();

  const geo = await startGeoService({
    registry,
    mongoClient,
    memcached,
    logger: silentLogger,
    tracer,
    port: 0,
    ipAddress: '127.0.0.1'
  });
  const rate = await startRateService({
    registry,
    mongoClient,
    memcached,
    logger: silentLogger,
    tracer,
    port: 0,
    ipAddress: '127.0.0.1'
  });
  const search = await startSearchService({
    registry,
    logger: silentLogger,
    tracer,
    port: 0,
    ipAddress: '127.0.0.1',
    knativeDns: ''
  });
  const client = await connectClient(registry, 'srv-search');

  try {
    const res = await client.call('Nearby', {
      lat: 0,
      lon: 0,
      inDate: '2015-04-09',
      outDate: '2015-04-10'
    });
    assert.deepEqual(res.hotelIds ?? [], []);
    assert.equal(memcached.sets.length, 0);
  } finally {
    client.close();
    await search.shutdown();
    await rate.shutdown();
    await geo.shutdown();
  }
});

test('search.Nearby: propagates geo service errors', async () => {
  const registry = new FakeRegistry();
  const geo = await startStubService(registry, 'srv-geo', 'geo', 'Geo', {
    Nearby: createUnaryHandler(async () => {
      throw new Error('geo boom');
    })
  });
  const search = await startSearchService({
    registry,
    logger: silentLogger,
    tracer,
    port: 0,
    ipAddress: '127.0.0.1',
    knativeDns: ''
  });
  const client = await connectClient(registry, 'srv-search');

  try {
    await assert.rejects(
      () =>
        client.call('Nearby', {
          lat: 37.0,
          lon: -122.0,
          inDate: '2015-04-09',
          outDate: '2015-04-10'
        }),
      /geo boom/
    );
  } finally {
    client.close();
    await search.shutdown();
    await geo.shutdown();
  }
});

test('search.Nearby: propagates rate service errors', async () => {
  const registry = new FakeRegistry();
  const geo = await startStubService(registry, 'srv-geo', 'geo', 'Geo', {
    Nearby: createUnaryHandler(async () => ({ hotelIds: ['1'] }))
  });
  const rate = await startStubService(registry, 'srv-rate', 'rate', 'Rate', {
    GetRates: createUnaryHandler(async () => {
      throw new Error('rate boom');
    })
  });
  const search = await startSearchService({
    registry,
    logger: silentLogger,
    tracer,
    port: 0,
    ipAddress: '127.0.0.1',
    knativeDns: ''
  });
  const client = await connectClient(registry, 'srv-search');

  try {
    await assert.rejects(
      () =>
        client.call('Nearby', {
          lat: 37.0,
          lon: -122.0,
          inDate: '2015-04-09',
          outDate: '2015-04-10'
        }),
      /rate boom/
    );
  } finally {
    client.close();
    await search.shutdown();
    await rate.shutdown();
    await geo.shutdown();
  }
});
