import { runService } from '../lib/serviceRunner.js';
import { seedRateDatabase } from '../seeds/rate.js';
import { startRateService } from '../services/rate/server.js';

await runService({
  serviceName: 'rate',
  portKey: 'RatePort',
  ipKey: 'RateIP',
  mongoKey: 'RateMongoAddress',
  memcachedKey: 'RateMemcAddress',
  seed: seedRateDatabase,
  start: startRateService
});
