import { createUnaryHandler, startGrpcServer } from '../../lib/grpc.js';
import { loadProto } from '../../lib/loadProto.js';

const rateProto = loadProto('rate');
const serviceName = 'srv-rate';

export async function startRateService({
  logger,
  tracer,
  registry,
  mongoClient,
  memcached,
  port,
  ipAddress
}) {
  const collection = mongoClient.db('rate-db').collection('inventory');

  return startGrpcServer({
    port,
    serviceName,
    ipAddress,
    registry,
    addServices(server) {
      server.addService(rateProto.Rate.service, {
        GetRates: createUnaryHandler(async (request) => {
          const hotelIds = [];
          const missing = new Map();
          const ratePlans = [];

          for (const hotelId of request.hotelIds ?? []) {
            hotelIds.push(hotelId);
            missing.set(hotelId, true);
          }

          const cached = await tracer.withSpan('memcached_get_multi_rate', () =>
            memcached.getMulti(hotelIds)
          );

          for (const [hotelId, item] of cached.entries()) {
            const lines = item.toString().split('\n');
            for (const line of lines) {
              if (line.length !== 0) {
                ratePlans.push(JSON.parse(line));
              }
            }
            missing.delete(hotelId);
          }

          await Promise.all(
            [...missing.keys()].map(async (hotelId) => {
              const fetched = await tracer.withSpan('mongo_rate', () =>
                collection.find({}).toArray()
              );

              let payload = '';
              for (const ratePlan of fetched) {
                ratePlans.push(ratePlan);
                payload += `${JSON.stringify(ratePlan)}\n`;
              }

              void memcached
                .set(hotelId, payload)
                .catch((error) => logger.error({ err: error }, 'memcached set failed'));
            })
          );

          ratePlans.sort(
            (left, right) =>
              (right.roomType?.totalRate ?? 0) - (left.roomType?.totalRate ?? 0)
          );

          return { ratePlans };
        })
      });
    }
  });
}
