import memjs from 'memjs';

const timeoutMs = Math.max(
  0,
  (Number.parseInt(process.env.MEMC_TIMEOUT ?? '2', 10) || 2) * 1000
);

function withTimeout(executor) {
  if (timeoutMs === 0) {
    return executor();
  }

  let timer;
  return Promise.race([
    executor().finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`memcached timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

export function createMemcachedClient(servers) {
  const client = memjs.Client.create(servers);

  async function get(key) {
    return withTimeout(
      () =>
        new Promise((resolve, reject) => {
          client.get(key, (error, value) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(value ?? null);
          });
        })
    );
  }

  async function getMulti(keys) {
    const results = new Map();
    await Promise.all(
      keys.map(async (key) => {
        const value = await get(key);
        if (value !== null) {
          results.set(key, value);
        }
      })
    );
    return results;
  }

  async function set(key, value, options = {}) {
    return withTimeout(
      () =>
        new Promise((resolve, reject) => {
          client.set(key, value, options, (error, status) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(status);
          });
        })
    );
  }

  return {
    get,
    getMulti,
    set,
    close() {
      client.quit();
    }
  };
}
