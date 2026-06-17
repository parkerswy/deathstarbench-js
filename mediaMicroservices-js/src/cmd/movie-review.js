'use strict';
require('./start').start('movie-review-service').catch((error) => { console.error(error); process.exit(1); });
