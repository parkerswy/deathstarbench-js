import { createUnaryHandler, startGrpcServer } from '../../lib/grpc.js';
import { loadProto } from '../../lib/loadProto.js';

const reviewProto = loadProto('review');
const serviceName = 'srv-review';

export async function startReviewService({
  logger,
  tracer,
  registry,
  mongoClient,
  memcached,
  port,
  ipAddress
}) {
  const collection = mongoClient.db('review-db').collection('reviews');

  return startGrpcServer({
    port,
    serviceName,
    ipAddress,
    registry,
    addServices(server) {
      server.addService(reviewProto.Review.service, {
        GetReviews: createUnaryHandler(async (request) => {
          const hotelId = request.hotelId;
          const item = await tracer.withSpan('memcached_get_review', () =>
            memcached.get(hotelId)
          );

          let reviews;
          if (item === null) {
            const fetched = await tracer.withSpan('mongo_review', () =>
              collection.find({ hotelId }).toArray()
            );

            reviews = fetched.map((review) => ({
              reviewId: review.reviewId,
              hotelId: review.hotelId,
              name: review.name,
              rating: review.rating,
              description: review.description,
              images: review.images
            }));

            void memcached
              .set(hotelId, JSON.stringify(reviews))
              .catch((error) => logger.error({ err: error }, 'memcached set failed'));
          } else {
            reviews = JSON.parse(item.toString());
          }

          return { reviews };
        })
      });
    }
  });
}
