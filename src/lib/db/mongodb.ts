import { Db, MongoClient } from "mongodb";

interface MongoCache {
  client?: MongoClient;
  database?: Promise<Db>;
}

const globalForMongo = globalThis as typeof globalThis & {
  betweenUsMongo?: MongoCache;
};

const cache = (globalForMongo.betweenUsMongo ??= {});

export async function getMongoDatabase(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required to access canonical memory data");
  }

  cache.client ??= new MongoClient(uri);
  cache.database ??= cache.client.connect().then((client) =>
    client.db(process.env.MONGODB_DB_NAME ?? "between_us"),
  );
  return cache.database;
}