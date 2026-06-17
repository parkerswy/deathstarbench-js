'use strict';
require('./start').start('user-service').catch((error) => { console.error(error); process.exit(1); });
