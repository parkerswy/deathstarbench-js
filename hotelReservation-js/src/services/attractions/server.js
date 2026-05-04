import { createUnaryHandler, startGrpcServer } from '../../lib/grpc.js';
import { loadProto } from '../../lib/loadProto.js';
import { haversineKm } from '../../lib/utils.js';

const attractionsProto = loadProto('attractions');
const serviceName = 'srv-attractions';
const maxSearchRadius = 10;
const maxSearchResults = 5;

function findNearby(points, lat, lon, idField) {
  return points
    .map((point) => ({
      point,
      distance: haversineKm(lat, lon, point.lat, point.lon)
    }))
    .filter((entry) => entry.distance <= maxSearchRadius)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, maxSearchResults)
    .map((entry) => entry.point[idField]);
}

async function loadHotelCoordinates(collection, hotelId) {
  const hotels = await collection.find({ hotelId }).toArray();
  let hotel = null;
  for (const entry of hotels) {
    hotel = entry;
  }
  return hotel;
}

export async function startAttractionsService({
  tracer,
  registry,
  mongoClient,
  port,
  ipAddress
}) {
  const database = mongoClient.db('attractions-db');
  const hotelsCollection = database.collection('hotels');
  const restaurants = await database.collection('restaurants').find({}).toArray();
  const museums = await database.collection('museums').find({}).toArray();
  const cinemas = await database.collection('cinemas').find({}).toArray();

  return startGrpcServer({
    port,
    serviceName,
    ipAddress,
    registry,
    addServices(server) {
      server.addService(attractionsProto.Attractions.service, {
        NearbyRest: createUnaryHandler(async (request) => {
          const hotel = await tracer.withSpan('mongo_restaurant', () =>
            loadHotelCoordinates(hotelsCollection, request.hotelId)
          );
          return {
            attractionIds: hotel
              ? findNearby(restaurants, hotel.lat, hotel.lon, 'restaurantId')
              : []
          };
        }),

        NearbyMus: createUnaryHandler(async (request) => {
          const hotel = await tracer.withSpan('mongo_museum', () =>
            loadHotelCoordinates(hotelsCollection, request.hotelId)
          );
          return {
            attractionIds: hotel ? findNearby(museums, hotel.lat, hotel.lon, 'museumId') : []
          };
        }),

        NearbyCinema: createUnaryHandler(async (request) => {
          const hotel = await tracer.withSpan('mongo_cinema', () =>
            loadHotelCoordinates(hotelsCollection, request.hotelId)
          );
          return {
            attractionIds: hotel
              ? findNearby(cinemas, hotel.lat, hotel.lon, 'cinemaId')
              : []
          };
        })
      });
    }
  });
}
