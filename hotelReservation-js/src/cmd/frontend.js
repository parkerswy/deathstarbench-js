import { runService } from '../lib/serviceRunner.js';
import { startFrontendService } from '../services/frontend/server.js';

await runService({
  serviceName: 'frontend',
  portKey: 'FrontendPort',
  ipKey: 'FrontendIP',
  start: startFrontendService
});
