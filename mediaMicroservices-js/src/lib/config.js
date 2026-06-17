'use strict';

const fs = require('node:fs');
const path = require('node:path');

const configPath = process.env.MEDIA_CONFIG_PATH ||
  path.resolve(__dirname, '../../config/service-config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

function address(name) {
  const entry = config[name];
  if (!entry || !entry.addr || !entry.port) {
    throw new Error(`Missing address configuration for ${name}`);
  }
  return entry;
}

module.exports = { address, config };

