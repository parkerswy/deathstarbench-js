'use strict';
require('./start').start('rating-service').catch((error) => { console.error(error); process.exit(1); });
