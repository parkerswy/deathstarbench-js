'use strict';

const fs = require('node:fs');
const path = require('node:path');

const generatedDir = path.resolve(__dirname, '../gen-nodejs');
const serviceFiles = fs.readdirSync(generatedDir)
  .filter((file) => file.endsWith('Service.js'));

for (const file of serviceFiles) {
  const filePath = path.join(generatedDir, file);
  const source = fs.readFileSync(filePath, 'utf8');
  const fixed = source.replace(
    /new ([A-Za-z0-9_]+_result)\(err\)/g,
    'new $1({se: err})'
  );
  fs.writeFileSync(filePath, fixed);
}
