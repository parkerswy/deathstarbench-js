'use strict';

const { createClient } = require('redis');
const { address } = require('./config');

async function connectRedis(name, logger) {
  const endpoint = address(`${name}-redis`);
  const client = createClient({ url: `redis://${endpoint.addr}:${endpoint.port}` });
  client.on('error', (error) => logger.error({ error }, 'Redis connection error'));
  await client.connect();
  return client;
}

module.exports = { connectRedis };

