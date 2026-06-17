'use strict';
require('./start').start('movie-info-service').catch((error) => { console.error(error); process.exit(1); });
