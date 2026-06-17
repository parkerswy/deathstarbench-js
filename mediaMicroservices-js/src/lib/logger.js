'use strict';

const pino = require('pino');

const levels = {
  error: 'error',
  warning: 'warn',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
  trace: 'trace'
};
const rawLevel = `${process.env.LOG_LEVEL || 'info'}`.trim().toLowerCase();
const root = pino({
  level: levels[rawLevel] || 'info',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime
});

function createLogger(service) {
  return root.child({ service });
}

module.exports = { createLogger };

