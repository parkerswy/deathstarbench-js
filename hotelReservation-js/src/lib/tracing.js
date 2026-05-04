class NoopSpan {
  setTag() {}

  recordException() {}

  end() {}
}

class Tracer {
  constructor(serviceName, ratio, host, logger) {
    this.serviceName = serviceName;
    this.ratio = ratio;
    this.host = host;
    this.logger = logger;
  }

  startSpan() {
    return new NoopSpan();
  }

  async withSpan(name, fn) {
    const span = this.startSpan(name);
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }
}

export function initTracing(serviceName, jaegerAddress, logger) {
  let ratio = Number.parseFloat(process.env.JAEGER_SAMPLE_RATIO ?? '0.01');
  if (!Number.isFinite(ratio)) {
    ratio = 0.01;
  }
  if (ratio > 1) {
    ratio = 1;
  }
  if (ratio < 0) {
    ratio = 0;
  }

  logger.info(
    {
      jaegerAddress,
      sampleRatio: ratio
    },
    'Tracing initialized in compatibility mode'
  );

  return new Tracer(serviceName, ratio, jaegerAddress, logger);
}
