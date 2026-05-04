import pino from 'pino';

const levelMap = {
  '': 'error',
  error: 'error',
  warning: 'warn',
  warn: 'warn',
  debug: 'debug',
  info: 'info',
  trace: 'trace'
};

function resolveLevel() {
  const raw = `${process.env.LOG_LEVEL ?? 'INFO'}`.trim().toLowerCase();
  return levelMap[raw] ?? 'info';
}

const rootLogger = pino({
  level: resolveLevel(),
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime
});

export function createLogger(name) {
  return rootLogger.child({ service: name });
}
