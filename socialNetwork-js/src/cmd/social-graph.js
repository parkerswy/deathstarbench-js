'use strict';
require('./start').start('social-graph-service').catch((error) => { console.error(error); process.exit(1); });
