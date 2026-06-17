'use strict';

// Shared helpers for the integration layer. These tests require the datastores
// from docker-compose.test.yml and the localhost config:
//   docker compose -f docker-compose.test.yml up -d --wait
//   npm run test:integration
// When MEDIA_IT is unset every integration test is skipped, so the default
// `npm test` stays hermetic.

const RUN = process.env.MEDIA_IT === '1';
const skip = RUN ? false : 'integration disabled (set MEDIA_IT=1 and start docker-compose.test.yml)';

const logger = { error() {}, info() {}, warn() {}, debug() {} };

let counter = 0n;

function uniqueId() {
  counter += 1n;
  return BigInt(Date.now()) * 1000000n + counter;
}

function uniqueName(prefix) {
  counter += 1n;
  return `${prefix}-${Date.now()}-${counter}`;
}

module.exports = { RUN, skip, logger, uniqueId, uniqueName };
