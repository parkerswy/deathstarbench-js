'use strict';
require('./start').start('user-review-service').catch((error) => { console.error(error); process.exit(1); });
