import crypto from 'node:crypto';

import { createUnaryHandler, startGrpcServer } from '../../lib/grpc.js';
import { loadProto } from '../../lib/loadProto.js';

const userProto = loadProto('user');
const serviceName = 'srv-user';

export async function startUserService({
  registry,
  mongoClient,
  port,
  ipAddress
}) {
  const records = await mongoClient.db('user-db').collection('user').find({}).toArray();
  const users = new Map(records.map((record) => [record.username, record.password]));

  return startGrpcServer({
    port,
    serviceName,
    ipAddress,
    registry,
    addServices(server) {
      server.addService(userProto.User.service, {
        CheckUser: createUnaryHandler(async (request) => {
          const password = crypto
            .createHash('sha256')
            .update(request.password ?? '')
            .digest('hex');

          const expected = users.get(request.username);
          return {
            correct: expected ? expected === password : false
          };
        })
      });
    }
  });
}
