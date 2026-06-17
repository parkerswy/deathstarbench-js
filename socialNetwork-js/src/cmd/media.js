'use strict';
require('./start').start('media-service').catch((error) => { console.error(error); process.exit(1); });
