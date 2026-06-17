'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { Report } = require('c8');

const root = path.resolve(__dirname, '..');
const packageJson = require('../package.json');
const coverageConfig = packageJson.c8 || {};
const reportsDirectory = path.join(root, 'coverage');
const tempDirectory = path.join(reportsDirectory, 'tmp');

function testFiles(directory) {
  return fs.readdirSync(path.join(root, directory))
    .filter((file) => file.endsWith('.test.js'))
    .sort()
    .map((file) => path.join(directory, file));
}

function pct(value) {
  return value === '' ? 100 : value;
}

async function main() {
  fs.rmSync(reportsDirectory, { recursive: true, force: true });
  fs.mkdirSync(tempDirectory, { recursive: true });

  const files = [
    ...testFiles('test'),
    ...testFiles('test/parity')
  ];
  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    env: { ...process.env, NODE_V8_COVERAGE: tempDirectory },
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  const report = Report({
    include: coverageConfig.include,
    exclude: coverageConfig.exclude,
    extension: coverageConfig.extension || ['.js'],
    reporter: coverageConfig.reporter || ['text'],
    reportsDirectory,
    tempDirectory,
    resolve: root,
    all: coverageConfig.all,
    src: root,
    excludeNodeModules: true,
    skipFull: coverageConfig.skipFull
  });

  await report.run();
  const summary = (await report.getCoverageMapFromAllCoverageFiles()).getCoverageSummary();
  let failed = false;
  for (const key of ['lines', 'functions', 'branches', 'statements']) {
    const threshold = coverageConfig[key];
    if (threshold == null) {
      continue;
    }
    const actual = pct(summary[key].pct);
    if (actual < threshold) {
      failed = true;
      console.error(
        `ERROR: Coverage for ${key} (${actual}%) does not meet global threshold (${threshold}%)`
      );
    }
  }
  if (failed) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
