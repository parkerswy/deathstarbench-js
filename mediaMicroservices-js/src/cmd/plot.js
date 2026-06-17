'use strict';
require('./start').start('plot-service').catch((error) => { console.error(error); process.exit(1); });
