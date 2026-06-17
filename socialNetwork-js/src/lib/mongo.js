'use strict';

const { MongoClient } = require('mongodb');
const { address } = require('./config');

async function connectMongo(endpointName, databaseName = endpointName, collectionName = databaseName) {
  const endpoint = address(`${endpointName}-mongodb`);
  const client = new MongoClient(`mongodb://${endpoint.addr}:${endpoint.port}`);
  await client.connect();
  return {
    client,
    collection: client.db(databaseName).collection(collectionName),
    close: () => client.close()
  };
}

async function uniqueIndex(collection, field) {
  await collection.createIndex({ [field]: 1 }, { unique: true });
}

module.exports = { connectMongo, uniqueIndex };
