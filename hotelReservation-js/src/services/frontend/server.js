import path from 'node:path';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { createResolvedClient } from '../../lib/grpc.js';
import { sendHttpError, sendJson, setCors } from '../../lib/http.js';
import { loadProto } from '../../lib/loadProto.js';
import { getHttpsOptions } from '../../lib/tls.js';
import {
  normalizeArray,
  parseLooseFloat,
  parseLooseInt
} from '../../lib/utils.js';

const attractionsProto = loadProto('attractions');
const profileProto = loadProto('profile');
const recommendationProto = loadProto('recommendation');
const reservationProto = loadProto('reservation');
const reviewProto = loadProto('review');
const searchProto = loadProto('search');
const userProto = loadProto('user');

function getQueryValue(request, key) {
  const value = request.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function geoJsonResponse(hotels) {
  const features = [];

  for (const hotel of hotels) {
    features.push({
      type: 'Feature',
      id: hotel.id,
      properties: {
        name: hotel.name,
        phone_number: hotel.phoneNumber
      },
      geometry: {
        type: 'Point',
        coordinates: [hotel.address?.lon ?? 0, hotel.address?.lat ?? 0]
      }
    });
  }

  return {
    type: 'FeatureCollection',
    features
  };
}

function checkDataFormat(date) {
  if (date.length !== 10) {
    return false;
  }

  for (let index = 0; index < 10; index += 1) {
    if (index === 4 || index === 7) {
      if (date[index] !== '-') {
        return false;
      }
      continue;
    }
    if (date[index] < '0' || date[index] > '9') {
      return false;
    }
  }

  return true;
}

export async function startFrontendService({
  logger,
  registry,
  port,
  knativeDns
}) {
  const searchClient = await createResolvedClient({
    serviceName: 'srv-search',
    protoPackage: searchProto,
    clientName: 'Search',
    registry,
    knativeDns,
    logger
  });
  const profileClient = await createResolvedClient({
    serviceName: 'srv-profile',
    protoPackage: profileProto,
    clientName: 'Profile',
    registry,
    knativeDns,
    logger
  });
  const recommendationClient = await createResolvedClient({
    serviceName: 'srv-recommendation',
    protoPackage: recommendationProto,
    clientName: 'Recommendation',
    registry,
    knativeDns,
    logger
  });
  const userClient = await createResolvedClient({
    serviceName: 'srv-user',
    protoPackage: userProto,
    clientName: 'User',
    registry,
    knativeDns,
    logger
  });
  const reservationClient = await createResolvedClient({
    serviceName: 'srv-reservation',
    protoPackage: reservationProto,
    clientName: 'Reservation',
    registry,
    knativeDns,
    logger
  });
  const reviewClient = await createResolvedClient({
    serviceName: 'srv-review',
    protoPackage: reviewProto,
    clientName: 'Review',
    registry,
    knativeDns,
    logger
  });
  const attractionsClient = await createResolvedClient({
    serviceName: 'srv-attractions',
    protoPackage: attractionsProto,
    clientName: 'Attractions',
    registry,
    knativeDns,
    logger
  });

  const app = Fastify({
    logger: false,
    https: getHttpsOptions() ?? undefined
  });

  app.setErrorHandler(async (error, request, reply) => {
    logger.error(
      {
        err: error,
        method: request.method,
        url: request.url,
        query: request.query
      },
      'Frontend request failed'
    );
    sendHttpError(reply, error.message, 500);
  });

  await app.register(fastifyStatic, {
    root: path.resolve(process.cwd(), 'src/static'),
    prefix: '/',
    index: ['index.html']
  });

  app.get('/', async (_request, reply) => reply.sendFile('index.html'));

  app.route({
    method: ['GET', 'POST'],
    url: '/hotels',
    async handler(request, reply) {
      setCors(reply);

      const inDate = getQueryValue(request, 'inDate') ?? '';
      const outDate = getQueryValue(request, 'outDate') ?? '';
      if (inDate === '' || outDate === '') {
        sendHttpError(reply, 'Please specify inDate/outDate params', 400);
        return;
      }

      const sLat = getQueryValue(request, 'lat') ?? '';
      const sLon = getQueryValue(request, 'lon') ?? '';
      if (sLat === '' || sLon === '') {
        sendHttpError(reply, 'Please specify location params', 400);
        return;
      }

      const lat = parseLooseFloat(sLat);
      const lon = parseLooseFloat(sLon);
      const searchResp = await searchClient.call('Nearby', {
        lat,
        lon,
        inDate,
        outDate
      });

      const locale = getQueryValue(request, 'locale') || 'en';
      const reservationResp = await reservationClient.call('CheckAvailability', {
        customerName: '',
        hotelId: normalizeArray(searchResp.hotelIds),
        inDate,
        outDate,
        roomNumber: 1
      });

      const profileResp = await profileClient.call('GetProfiles', {
        hotelIds: normalizeArray(reservationResp.hotelId),
        locale
      });

      sendJson(reply, geoJsonResponse(normalizeArray(profileResp.hotels)));
    }
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/recommendations',
    async handler(request, reply) {
      setCors(reply);

      const sLat = getQueryValue(request, 'lat') ?? '';
      const sLon = getQueryValue(request, 'lon') ?? '';
      if (sLat === '' || sLon === '') {
        sendHttpError(reply, 'Please specify location params', 400);
        return;
      }

      const requireParam = getQueryValue(request, 'require') ?? '';
      if (requireParam !== 'dis' && requireParam !== 'rate' && requireParam !== 'price') {
        sendHttpError(reply, 'Please specify require params', 400);
        return;
      }

      const recResp = await recommendationClient.call('GetRecommendations', {
        require: requireParam,
        lat: parseLooseFloat(sLat),
        lon: parseLooseFloat(sLon)
      });

      const locale = getQueryValue(request, 'locale') || 'en';
      const hotelIds = normalizeArray(recResp.hotelIds?.length ? recResp.hotelIds : recResp.HotelIds);
      const profileResp = await profileClient.call('GetProfiles', {
        hotelIds,
        locale
      });

      sendJson(reply, geoJsonResponse(normalizeArray(profileResp.hotels)));
    }
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/review',
    async handler(request, reply) {
      setCors(reply);

      const username = getQueryValue(request, 'username') ?? '';
      const password = getQueryValue(request, 'password') ?? '';
      if (username === '' || password === '') {
        sendHttpError(reply, 'Please specify username and password', 400);
        return;
      }

      const auth = await userClient.call('CheckUser', { username, password });
      let str = 'Logged-in successfully!';
      if (auth.correct === false) {
        str = 'Failed. Please check your username and password. ';
      }

      const hotelId = getQueryValue(request, 'hotelId') ?? '';
      if (hotelId === '') {
        sendHttpError(reply, 'Please specify hotelId params', 400);
        return;
      }

      const reviewResp = await reviewClient.call('GetReviews', { hotelId });
      str = `Have reviews = ${normalizeArray(reviewResp.reviews).length}`;
      if (normalizeArray(reviewResp.reviews).length === 0) {
        str = 'Failed. No Reviews. ';
      }

      sendJson(reply, { message: str });
    }
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/restaurants',
    async handler(request, reply) {
      setCors(reply);

      const username = getQueryValue(request, 'username') ?? '';
      const password = getQueryValue(request, 'password') ?? '';
      if (username === '' || password === '') {
        sendHttpError(reply, 'Please specify username and password', 400);
        return;
      }

      const auth = await userClient.call('CheckUser', { username, password });
      let str = 'Logged-in successfully!';
      if (auth.correct === false) {
        str = 'Failed. Please check your username and password. ';
      }

      const hotelId = getQueryValue(request, 'hotelId') ?? '';
      if (hotelId === '') {
        sendHttpError(reply, 'Please specify hotelId params', 400);
        return;
      }

      const resp = await attractionsClient.call('NearbyRest', { hotelId });
      str = `Have restaurants = ${normalizeArray(resp.attractionIds).length}`;
      if (normalizeArray(resp.attractionIds).length === 0) {
        str = 'Failed. No Restaurants. ';
      }

      sendJson(reply, { message: str });
    }
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/museums',
    async handler(request, reply) {
      setCors(reply);

      const username = getQueryValue(request, 'username') ?? '';
      const password = getQueryValue(request, 'password') ?? '';
      if (username === '' || password === '') {
        sendHttpError(reply, 'Please specify username and password', 400);
        return;
      }

      const auth = await userClient.call('CheckUser', { username, password });
      let str = 'Logged-in successfully!';
      if (auth.correct === false) {
        str = 'Failed. Please check your username and password. ';
      }

      const hotelId = getQueryValue(request, 'hotelId') ?? '';
      if (hotelId === '') {
        sendHttpError(reply, 'Please specify hotelId params', 400);
        return;
      }

      const resp = await attractionsClient.call('NearbyMus', { hotelId });
      str = `Have museums = ${normalizeArray(resp.attractionIds).length}`;
      if (normalizeArray(resp.attractionIds).length === 0) {
        str = 'Failed. No Museums. ';
      }

      sendJson(reply, { message: str });
    }
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/cinema',
    async handler(request, reply) {
      setCors(reply);

      const username = getQueryValue(request, 'username') ?? '';
      const password = getQueryValue(request, 'password') ?? '';
      if (username === '' || password === '') {
        sendHttpError(reply, 'Please specify username and password', 400);
        return;
      }

      const auth = await userClient.call('CheckUser', { username, password });
      let str = 'Logged-in successfully!';
      if (auth.correct === false) {
        str = 'Failed. Please check your username and password. ';
      }

      const hotelId = getQueryValue(request, 'hotelId') ?? '';
      if (hotelId === '') {
        sendHttpError(reply, 'Please specify hotelId params', 400);
        return;
      }

      const resp = await attractionsClient.call('NearbyCinema', { hotelId });
      str = `Have cinemas = ${normalizeArray(resp.attractionIds).length}`;
      if (normalizeArray(resp.attractionIds).length === 0) {
        str = 'Failed. No Cinemas. ';
      }

      sendJson(reply, { message: str });
    }
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/user',
    async handler(request, reply) {
      setCors(reply);

      const username = getQueryValue(request, 'username') ?? '';
      const password = getQueryValue(request, 'password') ?? '';
      if (username === '' || password === '') {
        sendHttpError(reply, 'Please specify username and password', 400);
        return;
      }

      const auth = await userClient.call('CheckUser', { username, password });
      let str = 'Login successfully!';
      if (auth.correct === false) {
        str = 'Failed. Please check your username and password. ';
      }

      sendJson(reply, { message: str });
    }
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/reservation',
    async handler(request, reply) {
      setCors(reply);

      const inDate = getQueryValue(request, 'inDate') ?? '';
      const outDate = getQueryValue(request, 'outDate') ?? '';
      if (inDate === '' || outDate === '') {
        sendHttpError(reply, 'Please specify inDate/outDate params', 400);
        return;
      }
      if (!checkDataFormat(inDate) || !checkDataFormat(outDate)) {
        sendHttpError(reply, 'Please check inDate/outDate format (YYYY-MM-DD)', 400);
        return;
      }

      const hotelId = getQueryValue(request, 'hotelId') ?? '';
      if (hotelId === '') {
        sendHttpError(reply, 'Please specify hotelId params', 400);
        return;
      }

      const customerName = getQueryValue(request, 'customerName') ?? '';
      if (customerName === '') {
        sendHttpError(reply, 'Please specify customerName params', 400);
        return;
      }

      const username = getQueryValue(request, 'username') ?? '';
      const password = getQueryValue(request, 'password') ?? '';
      if (username === '' || password === '') {
        sendHttpError(reply, 'Please specify username and password', 400);
        return;
      }

      const numberOfRoom = parseLooseInt(getQueryValue(request, 'number') ?? '');
      const auth = await userClient.call('CheckUser', { username, password });
      let str = 'Reserve successfully!';
      if (auth.correct === false) {
        str = 'Failed. Please check your username and password. ';
      }

      const resp = await reservationClient.call('MakeReservation', {
        customerName,
        hotelId: [hotelId],
        inDate,
        outDate,
        roomNumber: numberOfRoom
      });

      if (normalizeArray(resp.hotelId).length === 0) {
        str = 'Failed. Already reserved. ';
      }

      sendJson(reply, { message: str });
    }
  });

  await app.listen({
    host: '0.0.0.0',
    port
  });

  return {
    async shutdown() {
      searchClient.close();
      profileClient.close();
      recommendationClient.close();
      userClient.close();
      reservationClient.close();
      reviewClient.close();
      attractionsClient.close();
      await app.close();
    }
  };
}
