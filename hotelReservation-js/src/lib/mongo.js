import { MongoClient } from 'mongodb';

export async function connectMongo(address) {
  const client = new MongoClient(`mongodb://${address}`);
  await client.connect();
  return client;
}
