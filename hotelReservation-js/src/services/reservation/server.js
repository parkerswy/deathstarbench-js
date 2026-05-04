import { createUnaryHandler, startGrpcServer } from '../../lib/grpc.js';
import { loadProto } from '../../lib/loadProto.js';
import { addDays, formatStayDate, parseStayDate } from '../../lib/utils.js';

const reservationProto = loadProto('reservation');
const serviceName = 'srv-reservation';

export async function startReservationService({
  tracer,
  registry,
  mongoClient,
  memcached,
  port,
  ipAddress
}) {
  const database = mongoClient.db('reservation-db');
  const reservationsCollection = database.collection('reservation');
  const numbersCollection = database.collection('number');

  return startGrpcServer({
    port,
    serviceName,
    ipAddress,
    registry,
    addServices(server) {
      server.addService(reservationProto.Reservation.service, {
        MakeReservation: createUnaryHandler(async (request) => {
          const result = { hotelId: [] };

          let inDate = parseStayDate(request.inDate);
          const outDate = parseStayDate(request.outDate);
          const hotelId = request.hotelId[0];
          let indate = formatStayDate(inDate);
          const memcacheUpdates = new Map();

          while (inDate < outDate) {
            let count = 0;
            inDate = addDays(inDate, 1);
            const outdate = formatStayDate(inDate);
            const memcacheKey = `${hotelId}_${formatStayDate(inDate)}_${outdate}`;
            const cachedValue = await memcached.get(memcacheKey);

            if (cachedValue !== null) {
              count = Number.parseInt(cachedValue.toString(), 10) || 0;
              memcacheUpdates.set(memcacheKey, count + Number(request.roomNumber));
            } else {
              const reservations = await reservationsCollection
                .find({
                  hotelId,
                  inDate: indate,
                  outDate: outdate
                })
                .toArray();
              for (const reservation of reservations) {
                count += reservation.number;
              }
              memcacheUpdates.set(memcacheKey, count + Number(request.roomNumber));
            }

            const capacityKey = `${hotelId}_cap`;
            const cachedCapacity = await memcached.get(capacityKey);
            let hotelCapacity = 0;
            if (cachedCapacity !== null) {
              hotelCapacity = Number.parseInt(cachedCapacity.toString(), 10) || 0;
            } else {
              const number = await numbersCollection.findOne({ hotelId });
              hotelCapacity = Number(number?.numberOfRoom ?? 0);
              await memcached.set(capacityKey, `${hotelCapacity}`);
            }

            if (count + Number(request.roomNumber) > hotelCapacity) {
              return result;
            }

            indate = outdate;
          }

          for (const [key, value] of memcacheUpdates.entries()) {
            await memcached.set(key, `${value}`);
          }

          inDate = parseStayDate(request.inDate);
          indate = formatStayDate(inDate);

          while (inDate < outDate) {
            inDate = addDays(inDate, 1);
            const outdate = formatStayDate(inDate);

            await reservationsCollection.insertOne({
              hotelId,
              customerName: request.customerName,
              inDate: indate,
              outDate: outdate,
              number: Number(request.roomNumber)
            });

            indate = outdate;
          }

          result.hotelId.push(hotelId);
          return result;
        }),

        CheckAvailability: createUnaryHandler(async (request) => {
          const result = { hotelId: [] };
          const hotelMemKeys = [];
          const resultsMap = new Map();

          for (const hotelId of request.hotelId ?? []) {
            hotelMemKeys.push(`${hotelId}_cap`);
            resultsMap.set(hotelId, true);
          }

          const cacheMemRes = await tracer.withSpan(
            'memcached_capacity_get_multi_number',
            () => memcached.getMulti(hotelMemKeys)
          );

          const cacheCap = {};
          for (const [key, value] of cacheMemRes.entries()) {
            cacheCap[key] = Number.parseInt(value.toString(), 10) || 0;
          }

          const reqCommand = [];
          for (const hotelId of request.hotelId ?? []) {
            let inDate = parseStayDate(request.inDate);
            const outDate = parseStayDate(request.outDate);
            while (inDate < outDate) {
              inDate = addDays(inDate, 1);
              const endDate = formatStayDate(inDate);
              reqCommand.push(`${hotelId}_${endDate}_${endDate}`);
            }
          }

          const itemsMap = await tracer.withSpan(
            'memcached_reserve_get_multi_number',
            () => memcached.getMulti(reqCommand)
          );

          for (const [key, value] of itemsMap.entries()) {
            const hotelId = key.split('_')[0];
            const current = Number.parseInt(value.toString(), 10) || 0;
            const hotelCapacity = cacheCap[hotelId] ?? 0;
            if (current + Number(request.roomNumber) > hotelCapacity) {
              resultsMap.set(hotelId, false);
            }
          }

          for (const [hotelId, available] of resultsMap.entries()) {
            if (available) {
              result.hotelId.push(hotelId);
            }
          }

          return result;
        })
      });
    }
  });
}
