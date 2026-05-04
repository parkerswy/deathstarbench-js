import fs from 'node:fs';
import path from 'node:path';

const configPath = path.resolve(process.cwd(), 'config.json');

let cachedConfig;

function readConfig() {
  const source = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(source);
}

export function loadConfig() {
  if (!cachedConfig) {
    cachedConfig = Object.freeze(readConfig());
  }
  return cachedConfig;
}

export const config = loadConfig();

export function getConfigInt(key) {
  const value = Number.parseInt(config[key] ?? '0', 10);
  return Number.isNaN(value) ? 0 : value;
}
