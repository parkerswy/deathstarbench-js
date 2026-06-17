'use strict';
require('./start').start('page-service').catch((error) => { console.error(error); process.exit(1); });
