'use strict';
require('./start').start('movie-id-service').catch((error) => { console.error(error); process.exit(1); });
