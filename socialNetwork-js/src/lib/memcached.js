'use strict';

const memjs = require('memjs');
const { address } = require('./config');

const timeout = Math.max(0, Number.parseInt(process.env.MEMC_TIMEOUT || '2', 10) * 1000);

function timeoutCall(run) {
  if (!timeout) {
    return run();
  }
  let timer;
  return Promise.race([
    run().finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('memcached timeout')), timeout);
    })
  ]);
}

function createMemcached(name) {
  const endpoint = address(`${name}-memcached`);
  const client = memjs.Client.create(`${endpoint.addr}:${endpoint.port}`);

  function operation(method, ...args) {
    return timeoutCall(() => new Promise((resolve, reject) => {
      client[method](...args, (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    }));
  }

  return {
    async get(key) {
      return (await operation('get', key)) || null;
    },
    async getMulti(keys) {
      const pairs = await Promise.all(keys.map(async (entry) => [entry, await this.get(entry)]));
      return new Map(pairs.filter(([, value]) => value !== null));
    },
    set(key, value, options = {}) {
      return operation('set', key, value, options);
    },
    add(key, value, options = {}) {
      return operation('add', key, value, options);
    },
    increment(key, amount = 1) {
      return timeoutCall(() => new Promise((resolve, reject) => {
        client.increment(key, amount, {}, (error, success, value) => {
          if (error) {
            reject(error);
          } else if (!success) {
            reject(new Error(`memcached increment failed for ${key}`));
          } else {
            resolve(value);
          }
        });
      }));
    },
    delete(key) {
      return operation('delete', key);
    },
    close() {
      client.quit();
    }
  };
}

module.exports = { createMemcached };
