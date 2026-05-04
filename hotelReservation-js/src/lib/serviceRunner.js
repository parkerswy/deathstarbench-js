import { config, getConfigInt } from './config.js';
import { createLogger } from './logger.js';
import { connectMongo } from './mongo.js';
import { createMemcachedClient } from './memcached.js';
import { RegistryClient } from './registry.js';
import { initTracing } from './tracing.js';
import { getTlsWarning } from './tls.js';

export async function runService({
  serviceName,
  portKey,
  ipKey,
  mongoKey = null,
  memcachedKey = null,
  seed = null,
  start
}) {
  const logger = createLogger(serviceName);
  const tlsWarning = getTlsWarning();

  if (tlsWarning) {
    logger.warn(tlsWarning);
  }

  const tracer = initTracing(serviceName, config.jaegerAddress, logger);
  const registry = new RegistryClient(config.consulAddress, logger);

  let mongoClient = null;
  if (mongoKey) {
    logger.info({ address: config[mongoKey] }, 'Initializing MongoDB connection');
    mongoClient = await connectMongo(config[mongoKey]);
    if (seed) {
      await seed(mongoClient, logger);
    }
  }

  let memcached = null;
  if (memcachedKey) {
    logger.info({ address: config[memcachedKey] }, 'Initializing memcached client');
    memcached = createMemcachedClient(config[memcachedKey]);
  }

  const handle = await start({
    config,
    logger,
    tracer,
    registry,
    mongoClient,
    memcached,
    port: getConfigInt(portKey),
    ipAddress: config[ipKey] ?? '',
    consulAddress: config.consulAddress,
    knativeDns: config.KnativeDomainName ?? ''
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down service');

    try {
      await handle?.shutdown?.();
    } catch (error) {
      logger.error({ err: error }, 'Service shutdown failed');
    }

    try {
      memcached?.close?.();
    } catch (error) {
      logger.error({ err: error }, 'Memcached shutdown failed');
    }

    try {
      await mongoClient?.close?.();
    } catch (error) {
      logger.error({ err: error }, 'MongoDB shutdown failed');
    }

    process.exit(0);
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  return handle;
}
