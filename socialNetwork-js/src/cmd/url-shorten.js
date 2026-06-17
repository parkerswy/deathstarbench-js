'use strict';
require('./start').start('url-shorten-service').catch((error) => { console.error(error); process.exit(1); });
