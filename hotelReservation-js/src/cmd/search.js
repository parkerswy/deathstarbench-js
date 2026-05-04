import { runService } from '../lib/serviceRunner.js';
import { startSearchService } from '../services/search/server.js';

await runService({
  serviceName: 'search',
  portKey: 'SearchPort',
  ipKey: 'SearchIP',
  start: startSearchService
});
