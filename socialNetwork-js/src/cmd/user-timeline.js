'use strict';
require('./start').start('user-timeline-service').catch((error) => { console.error(error); process.exit(1); });
