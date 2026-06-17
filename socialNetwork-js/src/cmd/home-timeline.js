'use strict';
require('./start').start('home-timeline-service').catch((error) => { console.error(error); process.exit(1); });
