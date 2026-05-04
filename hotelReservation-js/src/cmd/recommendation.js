import { runService } from '../lib/serviceRunner.js';
import { seedRecommendationDatabase } from '../seeds/recommendation.js';
import { startRecommendationService } from '../services/recommendation/server.js';

await runService({
  serviceName: 'recommendation',
  portKey: 'RecommendPort',
  ipKey: 'RecommendIP',
  mongoKey: 'RecommendMongoAddress',
  seed: seedRecommendationDatabase,
  start: startRecommendationService
});
