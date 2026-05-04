import { createUnaryHandler, startGrpcServer } from '../../lib/grpc.js';
import { loadProto } from '../../lib/loadProto.js';

const profileProto = loadProto('profile');
const serviceName = 'srv-profile';

export async function startProfileService({
  logger,
  tracer,
  registry,
  mongoClient,
  memcached,
  port,
  ipAddress
}) {
  const collection = mongoClient.db('profile-db').collection('hotels');

  const handle = await startGrpcServer({
    port,
    serviceName,
    ipAddress,
    registry,
    addServices(server) {
      server.addService(profileProto.Profile.service, {
        GetProfiles: createUnaryHandler(async (request) => {
          const hotelIds = [];
          const profileMap = new Map();
          for (const hotelId of request.hotelIds ?? []) {
            hotelIds.push(hotelId);
            profileMap.set(hotelId, true);
          }

          const hotels = [];
          const cached = await tracer.withSpan('memcached_get_profile', () =>
            memcached.getMulti(hotelIds)
          );

          for (const [hotelId, item] of cached.entries()) {
            hotels.push(JSON.parse(item.toString()));
            profileMap.delete(hotelId);
          }

          await Promise.all(
            [...profileMap.keys()].map(async (hotelId) => {
              const hotel = await tracer.withSpan('mongo_profile', () =>
                collection.findOne({ id: hotelId })
              );

              hotels.push(hotel);
              void memcached
                .set(hotelId, JSON.stringify(hotel))
                .catch((error) => logger.error({ err: error }, 'memcached set failed'));
            })
          );

          return { hotels };
        })
      });
    }
  });

  return handle;
}
