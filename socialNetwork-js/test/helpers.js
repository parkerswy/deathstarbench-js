'use strict';

const { key, toBigInt, toLong } = require('../src/services/common');

function comparable(value) {
  if (value === undefined || value === null) {
    return value;
  }
  try {
    return key(value);
  } catch {
    return `${value}`;
  }
}

class MemoryCache {
  constructor() {
    this.values = new Map();
  }

  async get(name) {
    return this.values.has(name) ? Buffer.from(`${this.values.get(name)}`) : null;
  }

  async getMulti(names) {
    const result = new Map();
    for (const name of names) {
      if (this.values.has(name)) {
        result.set(name, Buffer.from(`${this.values.get(name)}`));
      }
    }
    return result;
  }

  async set(name, value) {
    this.values.set(name, `${value}`);
    return true;
  }

  async add(name, value) {
    if (this.values.has(name)) {
      return false;
    }
    this.values.set(name, `${value}`);
    return true;
  }

  async increment(name, amount) {
    const next = Number(this.values.get(name) || 0) + amount;
    this.values.set(name, `${next}`);
    return next;
  }
}

class MemoryRedis {
  constructor() {
    this.zsets = new Map();
  }

  setFor(name) {
    if (!this.zsets.has(name)) {
      this.zsets.set(name, new Map());
    }
    return this.zsets.get(name);
  }

  async zAdd(name, members, options = {}) {
    const set = this.setFor(name);
    const list = Array.isArray(members) ? members : [members];
    for (const member of list) {
      if (options.NX && set.has(member.value)) {
        continue;
      }
      set.set(member.value, member.score);
    }
  }

  async zRange(name, start, stop, options = {}) {
    return this.range(name, start, stop, Boolean(options.REV));
  }

  async zRevRange(name, start, stop) {
    return this.range(name, start, stop, true);
  }

  async zRem(name, value) {
    this.setFor(name).delete(value);
  }

  range(name, start, stop, reverse) {
    const rows = [...this.setFor(name).entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([value]) => value);
    if (reverse) {
      rows.reverse();
    }
    const end = stop < 0 ? undefined : stop + 1;
    return rows.slice(start, end);
  }
}

function tracer() {
  return {
    withSpan(name, carrier, fn) {
      return fn(carrier || {});
    }
  };
}

function recordingClient(resolver = async () => undefined) {
  const calls = [];
  return {
    calls,
    async call(...args) {
      calls.push(args);
      return resolver(...args);
    }
  };
}

function cursor(rows) {
  return { toArray: async () => rows };
}

function matches(doc, query) {
  for (const [field, expected] of Object.entries(query || {})) {
    const value = field.split('.').reduce((acc, part) => acc?.[part], doc);
    if (expected && typeof expected === 'object' && '$in' in expected) {
      if (!expected.$in.some((candidate) => comparable(candidate) === comparable(value))) {
        return false;
      }
    } else if (expected && typeof expected === 'object' && '$ne' in expected) {
      if (comparable(value) === comparable(expected.$ne)) {
        return false;
      }
    } else if (comparable(value) !== comparable(expected)) {
      return false;
    }
  }
  return true;
}

class MemoryCollection {
  constructor(rows = []) {
    this.rows = rows;
  }

  async insertOne(doc) {
    this.rows.push(doc);
    return { insertedId: this.rows.length - 1 };
  }

  async insertMany(docs) {
    this.rows.push(...docs);
    return { insertedCount: docs.length };
  }

  async findOne(query) {
    return this.rows.find((row) => matches(row, query)) || null;
  }

  find(query) {
    return cursor(this.rows.filter((row) => matches(row, query)));
  }

  async updateOne(query, update, options = {}) {
    let doc = this.rows.find((row) => comparable(row.user_id) === comparable(query.user_id));
    if (!doc && options.upsert) {
      doc = { user_id: query.user_id };
      this.rows.push(doc);
    }
    if (!doc) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    for (const [field, expected] of Object.entries(query)) {
      if (field.endsWith('.user_id') && expected?.$ne !== undefined) {
        const listName = field.slice(0, field.indexOf('.'));
        if ((doc[listName] || []).some((item) => comparable(item.user_id) === comparable(expected.$ne))) {
          return { matchedCount: 0, modifiedCount: 0 };
        }
      }
    }

    if (update.$push) {
      for (const [field, value] of Object.entries(update.$push)) {
        doc[field] ||= [];
        if (value && Array.isArray(value.$each)) {
          if (value.$position === 0) {
            doc[field].unshift(...value.$each);
          } else {
            doc[field].push(...value.$each);
          }
        } else {
          doc[field].push(value);
        }
      }
    }

    if (update.$pull) {
      for (const [field, condition] of Object.entries(update.$pull)) {
        doc[field] = (doc[field] || [])
          .filter((item) => comparable(item.user_id) !== comparable(condition.user_id));
      }
    }

    return { matchedCount: 1, modifiedCount: 1 };
  }

  async createIndex() {}
}

module.exports = {
  MemoryCache,
  MemoryCollection,
  MemoryRedis,
  recordingClient,
  toBigInt,
  toLong,
  tracer: tracer()
};
