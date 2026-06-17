'use strict';
require('./start').start('text-service').catch((error) => { console.error(error); process.exit(1); });
