import { createUnaryHandler, startGrpcServer } from '../../lib/grpc.js';
import { loadProto } from '../../lib/loadProto.js';
import { haversineKm } from '../../lib/utils.js';

const recommendationProto = loadProto('recommendation');
const serviceName = 'srv-recommendation';

export async function startRecommendationService({
  registry,
  mongoClient,
  port,
  ipAddress
}) {
  const hotels = await mongoClient
    .db('recommendation-db')
    .collection('recommendation')
    .find({})
    .toArray();

  return startGrpcServer({
    port,
    serviceName,
    ipAddress,
    registry,
    addServices(server) {
      server.addService(recommendationProto.Recommendation.service, {
        GetRecommendations: createUnaryHandler(async (request) => {
          const hotelIds = [];

          if (request.require === 'dis') {
            let minDistance = Number.POSITIVE_INFINITY;
            for (const hotel of hotels) {
              const distance = haversineKm(
                request.lat,
                request.lon,
                hotel.lat,
                hotel.lon
              );
              if (distance < minDistance) {
                minDistance = distance;
              }
            }
            for (const hotel of hotels) {
              const distance = haversineKm(
                request.lat,
                request.lon,
                hotel.lat,
                hotel.lon
              );
              if (distance === minDistance) {
                hotelIds.push(hotel.hotelId);
              }
            }
          } else if (request.require === 'rate') {
            let maxRate = 0;
            for (const hotel of hotels) {
              if (hotel.rate > maxRate) {
                maxRate = hotel.rate;
              }
            }
            for (const hotel of hotels) {
              if (hotel.rate === maxRate) {
                hotelIds.push(hotel.hotelId);
              }
            }
          } else if (request.require === 'price') {
            let minPrice = Number.POSITIVE_INFINITY;
            for (const hotel of hotels) {
              if (hotel.price < minPrice) {
                minPrice = hotel.price;
              }
            }
            for (const hotel of hotels) {
              if (hotel.price === minPrice) {
                hotelIds.push(hotel.hotelId);
              }
            }
          }

          return {
            hotelIds,
            HotelIds: hotelIds
          };
        })
      });
    }
  });
}
