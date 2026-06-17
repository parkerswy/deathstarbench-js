// Layer E - seed-data parity.
//
// Every differential/behavioral test below depends on the JS seeds producing
// byte-identical data to the Go `cmd/*/db.go` loaders. These tests pin the
// canonical counts, formulas, and a few exact documents so a seed drift is
// caught before it silently corrupts downstream parity checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { FakeMongoClient } from './helpers.js';

import { seedGeoDatabase } from '../src/seeds/geo.js';
import { seedRateDatabase } from '../src/seeds/rate.js';
import { seedProfileDatabase } from '../src/seeds/profile.js';
import { seedRecommendationDatabase } from '../src/seeds/recommendation.js';
import { seedReservationDatabase } from '../src/seeds/reservation.js';
import { seedReviewDatabase } from '../src/seeds/review.js';
import { seedAttractionsDatabase } from '../src/seeds/attractions.js';
import { seedUserDatabase } from '../src/seeds/user.js';

async function seededCollection(seed, dbName, collectionName) {
  const client = new FakeMongoClient();
  await seed(client);
  return client.db(dbName).collection(collectionName).find({}).toArray();
}

test('user seed: 501 users with Cornell_%x usernames and sha256 password hashes (matches cmd/user/db.go)', async () => {
  const users = await seededCollection(seedUserDatabase, 'user-db', 'user');
  assert.equal(users.length, 501); // i = 0..500 inclusive

  const byName = new Map(users.map((u) => [u.username, u.password]));

  // Go: fmt.Sprintf("Cornell_%x", strconv.Itoa(i)) -> hex of the decimal string.
  assert.ok(byName.has('Cornell_30'), 'id 0 -> hex("0") = "30"');
  assert.ok(byName.has('Cornell_31'), 'id 1 -> hex("1") = "31"');
  assert.ok(byName.has('Cornell_353030'), 'id 500 -> hex("500") = "353030"');

  // Password is sha256(hex) of the decimal id repeated 10 times.
  const expected0 = crypto.createHash('sha256').update('0000000000').digest('hex');
  assert.equal(byName.get('Cornell_30'), expected0);
  assert.equal(byName.get('Cornell_30').length, 64);

  const expected1 = crypto.createHash('sha256').update('1111111111').digest('hex');
  assert.equal(byName.get('Cornell_31'), expected1);
});

test('geo seed: 80 points; base docs exact; generated docs follow the i/500 formula', async () => {
  const points = await seededCollection(seedGeoDatabase, 'geo-db', 'geo');
  assert.equal(points.length, 80);

  const byId = new Map(points.map((p) => [p.hotelId, p]));
  assert.deepEqual(byId.get('1'), { hotelId: '1', lat: 37.7867, lon: -122.4112 });

  const generated = byId.get('7');
  assert.ok(Math.abs(generated.lat - (37.7835 + (7 / 500) * 3)) < 1e-9);
  assert.ok(Math.abs(generated.lon - (-122.41 + (7 / 500) * 4)) < 1e-9);
});

test('rate seed: 27 plans (ids 1-3 + multiples of 3 in 7..80); totalRate/outDate quirks', async () => {
  const plans = await seededCollection(seedRateDatabase, 'rate-db', 'inventory');
  assert.equal(plans.length, 27); // 3 base + 24 (multiples of 3 in 7..80)

  const byId = new Map(plans.map((p) => [p.hotelId, p]));
  assert.equal(byId.get('1').roomType.totalRate, 109);
  assert.equal(byId.get('1').roomType.totalRateInclusive, 123.17);

  // i=9: i%3==0, i%5==4 -> 232/258; i odd -> outDate 2015-04-24
  const nine = byId.get('9');
  assert.equal(nine.roomType.totalRate, 232);
  assert.equal(nine.roomType.totalRateInclusive, 258);
  assert.equal(nine.outDate, '2015-04-24');

  // Hotels without a rate plan (e.g. 4) are simply absent.
  assert.equal(plans.filter((p) => p.hotelId === '4').length, 0);
});

test('recommendation seed: 80 hotels with rate/price; base docs exact', async () => {
  const hotels = await seededCollection(
    seedRecommendationDatabase,
    'recommendation-db',
    'recommendation'
  );
  assert.equal(hotels.length, 80);

  const byId = new Map(hotels.map((h) => [h.hotelId, h]));
  assert.deepEqual(byId.get('2'), {
    hotelId: '2',
    lat: 37.7854,
    lon: -122.4005,
    rate: 139,
    price: 120
  });
});

test('reservation seed: 1 reservation row + 80 capacity rows; capacity by i%3', async () => {
  const client = new FakeMongoClient();
  await seedReservationDatabase(client);

  const reservations = await client
    .db('reservation-db')
    .collection('reservation')
    .find({})
    .toArray();
  assert.equal(reservations.length, 1);
  assert.deepEqual(reservations[0], {
    hotelId: '4',
    customerName: 'Alice',
    inDate: '2015-04-09',
    outDate: '2015-04-10',
    number: 1
  });

  const numbers = await client
    .db('reservation-db')
    .collection('number')
    .find({})
    .toArray();
  assert.equal(numbers.length, 80);
  const byId = new Map(numbers.map((n) => [n.hotelId, n.numberOfRoom]));
  assert.equal(byId.get('1'), 200);
  assert.equal(byId.get('7'), 300); // 7 % 3 == 1
  assert.equal(byId.get('8'), 250); // 8 % 3 == 2
  assert.equal(byId.get('9'), 200); // 9 % 3 == 0
});

test('review seed: 6 reviews keyed by hotelId, with image sub-doc', async () => {
  const reviews = await seededCollection(seedReviewDatabase, 'review-db', 'reviews');
  assert.equal(reviews.length, 6);
  assert.equal(reviews.filter((r) => r.hotelId === '1').length, 4);
  assert.equal(reviews.filter((r) => r.hotelId === '2').length, 2);
  const first = reviews.find((r) => r.reviewId === '1');
  assert.equal(first.rating, 3.4);
  assert.deepEqual(first.images, { url: 'some url', default: false });
});

test('profile seed: 80 hotels; hotel 3 lat diverges from geo (faithful Go cross-collection quirk)', async () => {
  const profiles = await seededCollection(seedProfileDatabase, 'profile-db', 'hotels');
  assert.equal(profiles.length, 80);

  const byId = new Map(profiles.map((p) => [p.id, p]));
  assert.equal(byId.get('1').name, 'Clift Hotel');
  assert.equal(byId.get('1').address.lat, 37.7867);

  // profile-db says hotel 3 is at lat 37.7834 ...
  assert.equal(byId.get('3').address.lat, 37.7834);
  // ... while geo-db says 37.7854. Both match Go; lock the discrepancy in.
  const geo = await seededCollection(seedGeoDatabase, 'geo-db', 'geo');
  assert.equal(geo.find((p) => p.hotelId === '3').lat, 37.7854);
});

test('attractions seed: hotels/restaurants/museums seeded, cinemas NOT seeded (matches Go)', async () => {
  const client = new FakeMongoClient();
  await seedAttractionsDatabase(client);
  const db = client.db('attractions-db');

  assert.equal((await db.collection('hotels').find({}).toArray()).length, 6);
  assert.equal((await db.collection('restaurants').find({}).toArray()).length, 6);
  assert.equal((await db.collection('museums').find({}).toArray()).length, 6);

  // Go's cmd/attractions/db.go never inserts a cinemas collection, so cinema
  // lookups are always empty. The JS port reproduces this faithfully.
  assert.equal((await db.collection('cinemas').find({}).toArray()).length, 0);
});
