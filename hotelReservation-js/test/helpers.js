// Shared test doubles and harness for the hotelReservation-js parity suite.
//
// The goal of the suite is to prove the JS port behaves identically to the Go
// reference (`hotelReservation/`). These helpers let a test start the real
// service code in-process, backed by in-memory Mongo/memcached doubles, and
// talk to it through the real gRPC client path.

import net from 'node:net';

import { createResolvedClient } from '../src/lib/grpc.js';
import { loadProto } from '../src/lib/loadProto.js';

import { seedGeoDatabase } from '../src/seeds/geo.js';
import { seedRateDatabase } from '../src/seeds/rate.js';
import { seedProfileDatabase } from '../src/seeds/profile.js';
import { seedRecommendationDatabase } from '../src/seeds/recommendation.js';
import { seedReservationDatabase } from '../src/seeds/reservation.js';
import { seedReviewDatabase } from '../src/seeds/review.js';
import { seedAttractionsDatabase } from '../src/seeds/attractions.js';
import { seedUserDatabase } from '../src/seeds/user.js';

// ---------------------------------------------------------------------------
// Loggers / tracing
// ---------------------------------------------------------------------------

export const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return silentLogger;
  }
};

const noopSpan = {
  setTag() {},
  recordException() {},
  end() {}
};

// Matches the shape used by every hotel service: `tracer.withSpan(name, fn)`
// where `fn` is invoked and its (promise) result returned.
export const tracer = {
  withSpan(_name, fn) {
    return fn(noopSpan);
  }
};

// ---------------------------------------------------------------------------
// In-memory memcached double (matches src/lib/memcached.js surface)
// ---------------------------------------------------------------------------

export class MemoryCache {
  constructor() {
    this.values = new Map();
    this.sets = []; // ordered log of [key, value] writes, for assertions
    this.getMultiCalls = []; // ordered log of getMulti key arrays, for assertions
  }

  async get(key) {
    return this.values.has(key) ? Buffer.from(this.values.get(key)) : null;
  }

  async getMulti(keys) {
    this.getMultiCalls.push([...keys]);
    const result = new Map();
    for (const key of keys) {
      if (this.values.has(key)) {
        result.set(key, Buffer.from(this.values.get(key)));
      }
    }
    return result;
  }

  async set(key, value) {
    const stored = `${value}`;
    this.values.set(key, stored);
    this.sets.push([key, stored]);
    return true;
  }

  async delete(key) {
    this.values.delete(key);
  }

  // test helper: prime a key as if a previous request had cached it
  seed(key, value) {
    this.values.set(key, `${value}`);
  }

  close() {}
}

// ---------------------------------------------------------------------------
// In-memory MongoDB double (matches the subset the services use)
// ---------------------------------------------------------------------------

function matchesFilter(doc, filter) {
  return Object.entries(filter).every(([key, value]) => doc[key] === value);
}

function clone(value) {
  return value === null || value === undefined
    ? value
    : JSON.parse(JSON.stringify(value));
}

class FakeCollection {
  constructor() {
    this.docs = [];
  }

  find(filter = {}) {
    const matched = this.docs
      .filter((doc) => matchesFilter(doc, filter))
      .map((doc) => clone(doc));
    return {
      toArray: async () => matched
    };
  }

  async findOne(filter = {}) {
    const found = this.docs.find((doc) => matchesFilter(doc, filter));
    return found ? clone(found) : null;
  }

  async insertOne(doc) {
    this.docs.push(clone(doc));
    return { acknowledged: true, insertedId: this.docs.length };
  }

  async insertMany(docs) {
    for (const doc of docs) {
      this.docs.push(clone(doc));
    }
    return { acknowledged: true, insertedCount: docs.length };
  }

  async countDocuments(filter = {}) {
    return this.docs.filter((doc) => matchesFilter(doc, filter)).length;
  }
}

class FakeDb {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new FakeCollection());
    }
    return this.collections.get(name);
  }
}

export class FakeMongoClient {
  constructor() {
    this.dbs = new Map();
  }

  db(name) {
    if (!this.dbs.has(name)) {
      this.dbs.set(name, new FakeDb());
    }
    return this.dbs.get(name);
  }

  async close() {}
}

export async function seedAll(mongoClient) {
  await seedGeoDatabase(mongoClient);
  await seedRateDatabase(mongoClient);
  await seedProfileDatabase(mongoClient);
  await seedRecommendationDatabase(mongoClient);
  await seedReservationDatabase(mongoClient);
  await seedReviewDatabase(mongoClient);
  await seedAttractionsDatabase(mongoClient);
  await seedUserDatabase(mongoClient);
}

// ---------------------------------------------------------------------------
// Consul/registry double + discovery
// ---------------------------------------------------------------------------

export class FakeRegistry {
  constructor() {
    this.services = new Map(); // name -> [{ id, ip, port }]
    this.byId = new Map(); // id -> name
  }

  async register(name, id, ip, port) {
    const entry = { id, ip: ip || '127.0.0.1', port };
    const list = this.services.get(name) ?? [];
    list.push(entry);
    this.services.set(name, list);
    this.byId.set(id, name);
  }

  async deregister(id) {
    const name = this.byId.get(id);
    if (name) {
      const list = (this.services.get(name) ?? []).filter((entry) => entry.id !== id);
      this.services.set(name, list);
      this.byId.delete(id);
    }
  }

  async listServices(name) {
    return (this.services.get(name) ?? []).map((entry) => ({
      ServiceAddress: entry.ip,
      Address: entry.ip,
      ServicePort: entry.port
    }));
  }
}

// ---------------------------------------------------------------------------
// gRPC client wiring
// ---------------------------------------------------------------------------

const PROTO_BY_SERVICE = {
  'srv-geo': { pkg: 'geo', client: 'Geo' },
  'srv-rate': { pkg: 'rate', client: 'Rate' },
  'srv-profile': { pkg: 'profile', client: 'Profile' },
  'srv-search': { pkg: 'search', client: 'Search' },
  'srv-recommendation': { pkg: 'recommendation', client: 'Recommendation' },
  'srv-reservation': { pkg: 'reservation', client: 'Reservation' },
  'srv-user': { pkg: 'user', client: 'User' },
  'srv-review': { pkg: 'review', client: 'Review' },
  'srv-attractions': { pkg: 'attractions', client: 'Attractions' }
};

export async function connectClient(registry, serviceName) {
  const mapping = PROTO_BY_SERVICE[serviceName];
  if (!mapping) {
    throw new Error(`No proto mapping for ${serviceName}`);
  }
  return createResolvedClient({
    serviceName,
    protoPackage: loadProto(mapping.pkg),
    clientName: mapping.client,
    registry,
    knativeDns: '',
    logger: silentLogger
  });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Round a JS double the way a protobuf `float` field truncates it on the wire.
export function asFloat32(value) {
  return Math.fround(value);
}
