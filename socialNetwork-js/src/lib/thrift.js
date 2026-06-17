'use strict';

const thrift = require('thrift');
const { address } = require('./config');

const wireOptions = {
  transport: thrift.TFramedTransport,
  protocol: thrift.TBinaryProtocol
};

const clientOptions = {
  ...wireOptions,
  // Services can be created before their dependencies are ready or recreated.
  // Keep queued RPCs reconnecting unless a deployment sets an explicit cap.
  max_attempts: Number.parseInt(
    process.env.THRIFT_MAX_CONNECT_ATTEMPTS || `${Number.MAX_SAFE_INTEGER}`,
    10
  ),
  retry_max_delay: 1000
};

if (process.env.THRIFT_CONNECT_TIMEOUT_MS) {
  clientOptions.connect_timeout = Number.parseInt(process.env.THRIFT_CONNECT_TIMEOUT_MS, 10);
}

function createServiceClient(Service, serviceName) {
  const endpoint = address(serviceName);
  const connection = thrift.createConnection(endpoint.addr, endpoint.port, clientOptions);
  connection.on('error', () => {});
  const client = thrift.createClient(Service, connection);

  return {
    async call(method, ...args) {
      return new Promise((resolve, reject) => {
        client[method](...args, (error, result) => {
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        });
      });
    },
    close() {
      connection.end();
    }
  };
}

function startServer(Service, instance, serviceName, logger) {
  const endpoint = address(serviceName);
  const server = thrift.createServer(Service, instance, wireOptions);
  server.on('error', (error) => logger.error({ error }, 'Thrift server error'));
  server.listen(endpoint.port, '0.0.0.0', () => {
    logger.info({ port: endpoint.port }, 'Thrift server listening');
  });
  return server;
}

module.exports = { createServiceClient, startServer };
