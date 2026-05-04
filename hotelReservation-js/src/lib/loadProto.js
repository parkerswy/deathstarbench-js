import path from 'node:path';

import * as grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const cache = new Map();
const protoRoot = path.resolve(process.cwd(), 'proto');

const loaderOptions = {
  keepCase: false,
  longs: String,
  defaults: true,
  oneofs: true
};

export function loadProto(packageName) {
  if (!cache.has(packageName)) {
    const protoPath = path.join(protoRoot, packageName, `${packageName}.proto`);
    const definition = protoLoader.loadSync(protoPath, loaderOptions);
    const packageObject = grpc.loadPackageDefinition(definition);
    cache.set(packageName, packageObject[packageName]);
  }

  return cache.get(packageName);
}
