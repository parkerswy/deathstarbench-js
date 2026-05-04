import { createResolvedClient, createUnaryHandler, startGrpcServer } from '../../lib/grpc.js';
import { loadProto } from '../../lib/loadProto.js';

const geoProto = loadProto('geo');
const rateProto = loadProto('rate');
const searchProto = loadProto('search');
const serviceName = 'srv-search';

export async function startSearchService({
  logger,
  registry,
  tracer,
  port,
  ipAddress,
  knativeDns
}) {
  const geoClient = await createResolvedClient({
    serviceName: 'srv-geo',
    protoPackage: geoProto,
    clientName: 'Geo',
    registry,
    knativeDns,
    logger
  });
  const rateClient = await createResolvedClient({
    serviceName: 'srv-rate',
    protoPackage: rateProto,
    clientName: 'Rate',
    registry,
    knativeDns,
    logger
  });

  const grpcHandle = await startGrpcServer({
    port,
    serviceName,
    ipAddress,
    registry,
    addServices(server) {
      server.addService(searchProto.Search.service, {
        Nearby: createUnaryHandler(async (request) => {
          const nearby = await geoClient.call('Nearby', {
            lat: request.lat,
            lon: request.lon
          });

          const rates = await rateClient.call('GetRates', {
            hotelIds: nearby.hotelIds,
            inDate: request.inDate,
            outDate: request.outDate
          });

          return {
            hotelIds: (rates.ratePlans ?? []).map((ratePlan) => ratePlan.hotelId)
          };
        })
      });
    }
  });

  return {
    ...grpcHandle,
    async shutdown() {
      geoClient.close();
      rateClient.close();
      await grpcHandle.shutdown();
    }
  };
}
