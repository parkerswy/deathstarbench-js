import { runService } from '../lib/serviceRunner.js';
import { seedAttractionsDatabase } from '../seeds/attractions.js';
import { startAttractionsService } from '../services/attractions/server.js';

await runService({
  serviceName: 'attractions',
  portKey: 'AttractionsPort',
  ipKey: 'AttractionsIP',
  mongoKey: 'AttractionsMongoAddress',
  seed: seedAttractionsDatabase,
  start: startAttractionsService
});
