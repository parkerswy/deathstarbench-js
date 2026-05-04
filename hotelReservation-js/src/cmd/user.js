import { runService } from '../lib/serviceRunner.js';
import { seedUserDatabase } from '../seeds/user.js';
import { startUserService } from '../services/user/server.js';

await runService({
  serviceName: 'user',
  portKey: 'UserPort',
  ipKey: 'UserIP',
  mongoKey: 'UserMongoAddress',
  seed: seedUserDatabase,
  start: startUserService
});
