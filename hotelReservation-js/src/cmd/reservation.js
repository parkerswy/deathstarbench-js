import { runService } from '../lib/serviceRunner.js';
import { seedReservationDatabase } from '../seeds/reservation.js';
import { startReservationService } from '../services/reservation/server.js';

await runService({
  serviceName: 'reservation',
  portKey: 'ReservePort',
  ipKey: 'ReserveIP',
  mongoKey: 'ReserveMongoAddress',
  memcachedKey: 'ReserveMemcAddress',
  seed: seedReservationDatabase,
  start: startReservationService
});
