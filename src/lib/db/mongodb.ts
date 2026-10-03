import { Db, MongoClient } from "mongodb";

interface MongoCache {
  client?: MongoClient;
  database?: Promise<Db>;
}

const globalForMongo = globalThis as typeof globalThis & {
  betweenUsMongo?: MongoCache;
};

const cache = (globalForMongo.betweenUsMongo ??= {});

export function getMongoClient(): MongoClient {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required to access canonical memory data");
  }

  cache.client ??= new MongoClient(uri);
  return cache.client;
}

export async function getMongoDatabase(): Promise<Db> {
  const client = getMongoClient();
  cache.database ??= client.connect().then((connectedClient) =>
    connectedClient.db(process.env.MONGODB_DB_NAME ?? "between_us"),
  );
  return cache.database;
}