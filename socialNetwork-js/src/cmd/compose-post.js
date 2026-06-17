'use strict';
require('./start').start('compose-post-service').catch((error) => { console.error(error); process.exit(1); });
