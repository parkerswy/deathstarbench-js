'use strict';
require('./start').start('unique-id-service').catch((error) => { console.error(error); process.exit(1); });
