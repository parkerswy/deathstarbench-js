'use strict';
require('./start').start('review-storage-service').catch((error) => { console.error(error); process.exit(1); });
