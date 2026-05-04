import { runService } from '../lib/serviceRunner.js';
import { seedProfileDatabase } from '../seeds/profile.js';
import { startProfileService } from '../services/profile/server.js';

await runService({
  serviceName: 'profile',
  portKey: 'ProfilePort',
  ipKey: 'ProfileIP',
  mongoKey: 'ProfileMongoAddress',
  memcachedKey: 'ProfileMemcAddress',
  seed: seedProfileDatabase,
  start: startProfileService
});
