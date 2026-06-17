'use strict';
require('./start').start('user-mention-service').catch((error) => { console.error(error); process.exit(1); });
