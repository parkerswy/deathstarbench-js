import { runService } from '../lib/serviceRunner.js';
import { seedReviewDatabase } from '../seeds/review.js';
import { startReviewService } from '../services/review/server.js';

await runService({
  serviceName: 'review',
  portKey: 'ReviewPort',
  ipKey: 'ReviewIP',
  mongoKey: 'ReviewMongoAddress',
  memcachedKey: 'ReviewMemcAddress',
  seed: seedReviewDatabase,
  start: startReviewService
});
