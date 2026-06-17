'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sharedNodeModules = path.resolve(root, '../mediaMicroservices-js/node_modules');
const nodePath = process.env.NODE_PATH
  ? `${sharedNodeModules}${path.delimiter}${process.env.NODE_PATH}`
  : sharedNodeModules;

const args = [
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-include=src/services/**/*.js',
  '--test-coverage-include=src/lib/i64.js',
  '--test-coverage-include=src/lib/idGenerator.js',
  '--test-coverage-include=src/lib/errors.js',
  '--test-coverage-lines=90',
  '--test-coverage-functions=90',
  '--test-coverage-branches=80',
  'test/lib.test.js',
  'test/services.test.js',
  'test/thriftInterop.test.js'
];

const result = spawnSync(process.execPath, args, {
  cwd: root,
  env: { ...process.env, NODE_PATH: nodePath },
  stdio: 'inherit'
});

if (result.error) {
  console.error(result.error.stack || result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
