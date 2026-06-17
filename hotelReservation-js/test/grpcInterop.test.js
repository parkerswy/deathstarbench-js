// Layer C - gRPC / proto wire interop.
//
// Exercises the cross-language wire behavior the Go and JS stacks must share:
// proto `float` fields truncate to float32 on the wire while `double` fields
// keep full precision, and nested/repeated messages round-trip with the
// camelCase field names produced by keepCase:false.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createUnaryHandler, startGrpcServer } from '../src/lib/grpc.js';
import { loadProto } from '../src/lib/loadProto.js';
import { FakeRegistry, asFloat32, connectClient } from './helpers.js';

async function startEcho(serviceName, pkg, serviceKey, handlers) {
  const registry = new FakeRegistry();
  const proto = loadProto(pkg);
  const handle = await startGrpcServer({
    port: 0,
    serviceName,
    ipAddress: '127.0.0.1',
    registry,
    addServices(server) {
      server.addService(proto[serviceKey].service, handlers);
    }
  });
  const client = await connectClient(registry, serviceName);
  return {
    client,
    async stop() {
      client.close();
      await handle.shutdown();
    }
  };
}

test('proto `float` fields (geo lat/lon) truncate to float32 on the wire', async () => {
  const echo = await startEcho('srv-geo', 'geo', 'Geo', {
    Nearby: createUnaryHandler(async (req) => ({
      hotelIds: [String(req.lat), String(req.lon)]
    }))
  });
  try {
    const res = await echo.client.call('Nearby', { lat: 37.7867, lon: -122.4112 });
    assert.equal(res.hotelIds[0], String(asFloat32(37.7867)));
    assert.equal(res.hotelIds[1], String(asFloat32(-122.4112)));
    // The float32 value is observably different from the original double.
    assert.notEqual(asFloat32(37.7867), 37.7867);
  } finally {
    await echo.stop();
  }
});

test('proto `double` fields (recommendation lat/lon) preserve full precision', async () => {
  const echo = await startEcho('srv-recommendation', 'recommendation', 'Recommendation', {
    GetRecommendations: createUnaryHandler(async (req) => ({
      HotelIds: [String(req.lat), String(req.lon)]
    }))
  });
  try {
    const res = await echo.client.call('GetRecommendations', {
      require: 'dis',
      lat: 37.78671234567,
      lon: -122.41129876543
    });
    assert.equal(res.HotelIds[0], '37.78671234567');
    assert.equal(res.HotelIds[1], '-122.41129876543');
  } finally {
    await echo.stop();
  }
});

test('nested + repeated messages round-trip with camelCase field names', async () => {
  const echo = await startEcho('srv-profile', 'profile', 'Profile', {
    GetProfiles: createUnaryHandler(async () => ({
      hotels: [
        {
          id: '1',
          name: 'Clift Hotel',
          phoneNumber: '(415) 775-4700',
          description: 'desc',
          address: {
            streetNumber: '495',
            streetName: 'Geary St',
            city: 'San Francisco',
            state: 'CA',
            country: 'United States',
            postalCode: '94102',
            lat: 37.7867,
            lon: -122.4112
          },
          images: [
            { url: 'u1', default: true },
            { url: 'u2', default: false }
          ]
        }
      ]
    }))
  });
  try {
    const res = await echo.client.call('GetProfiles', { hotelIds: ['1'], locale: 'en' });
    const hotel = res.hotels[0];
    assert.equal(hotel.id, '1');
    assert.equal(hotel.phoneNumber, '(415) 775-4700'); // camelCase, not phone_number
    assert.equal(hotel.address.streetNumber, '495');
    assert.equal(hotel.address.city, 'San Francisco');
    // Address.lat is a proto `float` -> float32 on the wire.
    assert.ok(Math.abs(hotel.address.lat - asFloat32(37.7867)) < 1e-9);
    // repeated nested messages + bool field.
    assert.equal(hotel.images.length, 2);
    assert.equal(hotel.images[0].url, 'u1');
    assert.equal(hotel.images[0].default, true);
    assert.equal(hotel.images[1].default, false);
  } finally {
    await echo.stop();
  }
});

test('repeated string fields (reservation hotelId) round-trip in order', async () => {
  const echo = await startEcho('srv-reservation', 'reservation', 'Reservation', {
    MakeReservation: createUnaryHandler(async (req) => ({ hotelId: req.hotelId })),
    CheckAvailability: createUnaryHandler(async (req) => ({ hotelId: req.hotelId }))
  });
  try {
    const res = await echo.client.call('MakeReservation', {
      customerName: 'Bob',
      hotelId: ['a', 'b', 'c'],
      inDate: '2015-04-09',
      outDate: '2015-04-10',
      roomNumber: 7
    });
    assert.deepEqual(res.hotelId, ['a', 'b', 'c']);
  } finally {
    await echo.stop();
  }
});
