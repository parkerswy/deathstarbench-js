import { createUnaryHandler, startGrpcServer } from '../../lib/grpc.js';
import { loadProto } from '../../lib/loadProto.js';
import { haversineKm } from '../../lib/utils.js';

const geoProto = loadProto('geo');
const serviceName = 'srv-geo';
const maxSearchRadius = 10;
const maxSearchResults = 5;

function findNearby(points, lat, lon) {
  return points
    .map((point) => ({
      point,
      distance: haversineKm(lat, lon, point.lat, point.lon)
    }))
    .filter((entry) => entry.distance <= maxSearchRadius)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, maxSearchResults)
    .map((entry) => entry.point);
}

export async function startGeoService({
  registry,
  mongoClient,
  port,
  ipAddress
}) {
  const points = await mongoClient.db('geo-db').collection('geo').find({}).toArray();

  return startGrpcServer({
    port,
    serviceName,
    ipAddress,
    registry,
    addServices(server) {
      server.addService(geoProto.Geo.service, {
        Nearby: createUnaryHandler(async (request) => ({
          hotelIds: findNearby(points, request.lat, request.lon).map(
            (point) => point.hotelId
          )
        }))
      });
    }
  });
}
