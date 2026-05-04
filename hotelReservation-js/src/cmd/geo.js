import { runService } from '../lib/serviceRunner.js';
import { seedGeoDatabase } from '../seeds/geo.js';
import { startGeoService } from '../services/geo/server.js';

await runService({
  serviceName: 'geo',
  portKey: 'GeoPort',
  ipKey: 'GeoIP',
  mongoKey: 'GeoMongoAddress',
  seed: seedGeoDatabase,
  start: startGeoService
});
