'use strict';

class NoopSpan {
  end() {}
}

class CompatibilityTracer {
  constructor(serviceName, logger) {
    this.serviceName = serviceName;
    logger.info('Tracing initialized in compatibility mode');
  }

  async withSpan(name, carrier, fn) {
    const span = new NoopSpan();
    try {
      return await fn(carrier || {});
    } finally {
      span.end();
    }
  }
}

function initTracing(serviceName, logger) {
  return new CompatibilityTracer(serviceName, logger);
}

module.exports = { initTracing };

