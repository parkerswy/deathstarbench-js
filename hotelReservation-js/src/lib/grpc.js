import { randomUUID } from 'node:crypto';

import * as grpc from '@grpc/grpc-js';

import { resolveServiceAddress } from './discovery.js';
import { getGrpcClientCredentials, getGrpcServerCredentials } from './tls.js';

const grpcOptions = {
  'grpc.keepalive_time_ms': 120000,
  'grpc.keepalive_timeout_ms': 120000,
  'grpc.keepalive_permit_without_calls': 1
};

function isRetriableError(error) {
  return error?.code === grpc.status.UNAVAILABLE || error?.code === grpc.status.CANCELLED;
}

export function createUnaryHandler(fn) {
  return async (call, callback) => {
    try {
      const result = await fn(call.request, call.metadata);
      callback(null, result);
    } catch (error) {
      callback(error);
    }
  };
}

export function unaryCall(client, method, request) {
  return new Promise((resolve, reject) => {
    client[method](request, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

export async function createResolvedClient({
  serviceName,
  protoPackage,
  clientName,
  registry,
  knativeDns,
  logger
}) {
  let client;
  let connectPromise;
  const clients = new Set();

  async function connect(force = false) {
    if (!force && client) {
      return client;
    }

    if (!connectPromise) {
      connectPromise = (async () => {
        const address = await resolveServiceAddress(registry, serviceName, knativeDns);
        const nextClient = new protoPackage[clientName](
          address,
          getGrpcClientCredentials(),
          grpcOptions
        );
        clients.add(nextClient);
        client = nextClient;
        return nextClient;
      })();

      connectPromise.finally(() => {
        connectPromise = null;
      });
    }

    return connectPromise;
  }

  return {
    async call(method, request) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const callClient = client ?? await connect();
          return await unaryCall(callClient, method, request);
        } catch (error) {
          if (attempt === 0 && isRetriableError(error)) {
            logger.warn(
              {
                serviceName,
                message: error.message
              },
              'Retrying gRPC call after reconnect'
            );
            await connect(true);
            continue;
          }
          throw error;
        }
      }

      throw new Error(`unreachable gRPC retry loop for ${serviceName}`);
    },

    close() {
      for (const createdClient of clients) {
        createdClient.close?.();
      }
      clients.clear();
      client = undefined;
    }
  };
}

export async function startGrpcServer({
  port,
  serviceName,
  ipAddress,
  registry,
  addServices
}) {
  const server = new grpc.Server(grpcOptions);
  addServices(server);

  const boundPort = await new Promise((resolve, reject) => {
    server.bindAsync(
      `0.0.0.0:${port}`,
      getGrpcServerCredentials(),
      (error, actualPort) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(actualPort);
      }
    );
  });

  const registrationId = randomUUID();
  await registry.register(serviceName, registrationId, ipAddress, boundPort);
  server.start();

  return {
    server,
    registrationId,
    async shutdown() {
      await registry.deregister(registrationId);
      await new Promise((resolve) => server.tryShutdown(resolve));
    }
  };
}
