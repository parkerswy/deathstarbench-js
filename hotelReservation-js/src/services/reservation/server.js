import { createUnaryHandler, startGrpcServer } from '../../lib/grpc.js';
import { loadProto } from '../../lib/loadProto.js';
import { addDays, formatStayDate, parseStayDate } from '../../lib/utils.js';

const reservationProto = loadProto('reservation');
const serviceName = 'srv-reservation';

function cacheKeyHotelId(key) {
  return key.endsWith('_cap') ? key.slice(0, -4) : key.split('_')[0];
}

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
          const hotelIds = request.hotelId ?? [];
          const hotelMemKeys = [];
          const resultsMap = new Map();

          for (const hotelId of hotelIds) {
            hotelMemKeys.push(`${hotelId}_cap`);
            resultsMap.set(hotelId, true);
          }

          const cacheMemRes = await tracer.withSpan(
            'memcached_capacity_get_multi_number',
            () => memcached.getMulti(hotelMemKeys)
          );

          const cacheCap = new Map();
          for (const [key, value] of cacheMemRes.entries()) {
            cacheCap.set(cacheKeyHotelId(key), Number.parseInt(value.toString(), 10) || 0);
          }

          for (const hotelId of hotelIds) {
            if (cacheCap.has(hotelId)) {
              continue;
            }
            const number = await numbersCollection.findOne({ hotelId });
            const hotelCapacity = Number(number?.numberOfRoom ?? 0);
            cacheCap.set(hotelId, hotelCapacity);
            if (number) {
              await memcached.set(`${hotelId}_cap`, `${hotelCapacity}`);
            }
          }

          const reqCommand = [];
          const queryMap = new Map();
          for (const hotelId of hotelIds) {
            let inDate = parseStayDate(request.inDate);
            const outDate = parseStayDate(request.outDate);
            while (inDate < outDate) {
              const startDate = formatStayDate(inDate);
              inDate = addDays(inDate, 1);
              const endDate = formatStayDate(inDate);
              const key = `${hotelId}_${endDate}_${endDate}`;
              reqCommand.push(key);
              queryMap.set(key, { hotelId, inDate: startDate, outDate: endDate });
            }
          }

          const itemsMap = await tracer.withSpan(
            'memcached_reserve_get_multi_number',
            () => memcached.getMulti(reqCommand)
          );

          for (const [key, value] of itemsMap.entries()) {
            const hotelId = cacheKeyHotelId(key);
            const current = Number.parseInt(value.toString(), 10) || 0;
            const hotelCapacity = cacheCap.get(hotelId) ?? 0;
            if (current + Number(request.roomNumber) > hotelCapacity) {
              resultsMap.set(hotelId, false);
            }
            queryMap.delete(key);
          }

          for (const [key, query] of queryMap.entries()) {
            const reservations = await reservationsCollection
              .find({
                hotelId: query.hotelId,
                inDate: query.inDate,
                outDate: query.outDate
              })
              .toArray();
            let current = 0;
            for (const reservation of reservations) {
              current += Number(reservation.number ?? 0);
            }
            await memcached.set(key, `${current}`);

            const hotelCapacity = cacheCap.get(query.hotelId) ?? 0;
            if (current + Number(request.roomNumber) > hotelCapacity) {
              resultsMap.set(query.hotelId, false);
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
