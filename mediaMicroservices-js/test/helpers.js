'use strict';

const { Long } = require('mongodb');

// In-memory memcached fake. Models the subset the handlers use, including the
// atomic add/increment semantics ComposeReviewService relies on as a fan-in gate.
class MemoryCache {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.has(key) ? Buffer.from(`${this.values.get(key)}`) : null;
  }

  async getMulti(keys) {
    const result = new Map();
    for (const key of keys) {
      if (this.values.has(key)) {
        result.set(key, Buffer.from(`${this.values.get(key)}`));
      }
    }
    return result;
  }

  async set(key, value) {
    this.values.set(key, `${value}`);
    return true;
  }

  async add(key, value) {
    if (this.values.has(key)) {
      return false;
    }
    this.values.set(key, `${value}`);
    return true;
  }

  async increment(key, amount) {
    const value = Number(this.values.get(key) || 0) + amount;
    this.values.set(key, `${value}`);
    return value;
  }

  async delete(key) {
    this.values.delete(key);
  }
}

// In-memory Redis fake covering the string counters and sorted-set operations
// used by RatingHandler and ReviewIndexHandler.
class MemoryRedis {
  constructor() {
    this.strings = new Map();
    this.zsets = new Map();
  }

  async incr(key) {
    return this.incrBy(key, 1);
  }

  async incrBy(key, amount) {
    const value = Number(this.strings.get(key) || 0) + amount;
    this.strings.set(key, value);
    return value;
  }

  async zCard(key) {
    const zset = this.zsets.get(key);
    return zset ? zset.size : 0;
  }

  async zAdd(key, members, options = {}) {
    const zset = this.zsets.get(key) || new Map();
    for (const { score, value } of members) {
      if (options.NX && zset.has(value)) {
        continue;
      }
      zset.set(value, score);
    }
    this.zsets.set(key, zset);
    return members.length;
  }

  // Redis ZRANGE indices are inclusive on both ends.
  async zRange(key, start, stop, options = {}) {
    const zset = this.zsets.get(key);
    if (!zset) {
      return [];
    }
    const entries = [...zset.entries()].sort(([aValue, aScore], [bValue, bScore]) =>
      aScore - bScore || (aValue < bValue ? -1 : aValue > bValue ? 1 : 0));
    if (options.REV) {
      entries.reverse();
    }
    return entries.slice(start, stop + 1).map(([value]) => value);
  }

  async del(key) {
    this.zsets.delete(key);
    this.strings.delete(key);
  }
}

// In-memory MongoDB collection fake. Supports the query/update shapes the
// handlers issue: equality (with Long/BigInt normalization), `$in`, `$push`
// with `$each`/`$position`, `$set`, and `$slice` projections.
function normalize(value) {
  if (Long.isLong(value)) {
    return `i64:${value.toBigInt()}`;
  }
  if (typeof value === 'bigint') {
    return `i64:${value}`;
  }
  return value;
}

function matchesField(docValue, condition) {
  if (condition && typeof condition === 'object' && !Long.isLong(condition) && '$in' in condition) {
    return condition.$in.some((entry) => normalize(entry) === normalize(docValue));
  }
  return normalize(docValue) === normalize(condition);
}

function matches(doc, query) {
  return Object.entries(query).every(([field, condition]) => matchesField(doc[field], condition));
}

function project(doc, projection) {
  const result = { ...doc };
  for (const [field, spec] of Object.entries(projection)) {
    if (spec && typeof spec === 'object' && '$slice' in spec && Array.isArray(result[field])) {
      const [skip, limit] = spec.$slice;
      result[field] = result[field].slice(skip, skip + limit);
    }
  }
  return result;
}

class MemoryCollection {
  constructor(docs = []) {
    this.docs = docs;
    this.inserts = [];
    this.finds = 0;
    this.findOnes = 0;
  }

  async insertOne(doc) {
    this.inserts.push(doc);
    this.docs.push(doc);
    return { acknowledged: true };
  }

  async findOne(query, options = {}) {
    this.findOnes += 1;
    const doc = this.docs.find((entry) => matches(entry, query));
    if (!doc) {
      return null;
    }
    return options.projection ? project(doc, options.projection) : doc;
  }

  find(query) {
    this.finds += 1;
    const matched = this.docs.filter((entry) => matches(entry, query));
    return { toArray: async () => matched };
  }

  async updateOne(selector, update, options = {}) {
    let doc = this.docs.find((entry) => matches(entry, selector));
    if (!doc) {
      if (!options.upsert) {
        return { matchedCount: 0, upsertedCount: 0 };
      }
      doc = { ...selector };
      this.docs.push(doc);
    }
    if (update.$push) {
      for (const [field, spec] of Object.entries(update.$push)) {
        doc[field] = doc[field] || [];
        if (spec && typeof spec === 'object' && '$each' in spec) {
          const position = spec.$position ?? doc[field].length;
          doc[field].splice(position, 0, ...spec.$each);
        } else {
          doc[field].push(spec);
        }
      }
    }
    if (update.$set) {
      Object.assign(doc, update.$set);
    }
    return { matchedCount: 1 };
  }
}

const tracer = {
  withSpan(name, carrier, fn) {
    return fn(carrier || {});
  }
};

// Records every `.call()` invocation; optional `impl` supplies the return value.
function recordingClient(impl) {
  const calls = [];
  return {
    calls,
    async call(...args) {
      calls.push(args);
      return impl ? impl(...args) : undefined;
    }
  };
}

module.exports = { MemoryCache, MemoryCollection, MemoryRedis, recordingClient, tracer };
