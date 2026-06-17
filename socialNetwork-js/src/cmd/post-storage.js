'use strict';
require('./start').start('post-storage-service').catch((error) => { console.error(error); process.exit(1); });
