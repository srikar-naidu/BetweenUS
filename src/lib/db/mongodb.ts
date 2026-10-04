import { Db, MongoClient } from "mongodb";

interface MongoCache {
  uri?: string;
  client?: MongoClient;
  database?: Promise<Db>;
}

const globalForMongo = globalThis as typeof globalThis & {
  betweenUsMongo?: MongoCache;
};

const cache = (globalForMongo.betweenUsMongo ??= {});

export function getMongoClient(): MongoClient {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) {
    throw new Error("MONGODB_URI is required to access canonical memory data");
  }

  if (cache.client && cache.uri !== uri) {
    const staleClient = cache.client;
    cache.client = undefined;
    cache.database = undefined;
    void staleClient.close().catch(() => {
      console.warn("Previous MongoDB connection could not be closed during configuration reload");
    });
  }
  if (!cache.client) {
    cache.client = new MongoClient(uri);
    cache.uri = uri;
  }
  return cache.client;
}

export async function getMongoDatabase(): Promise<Db> {
  const client = getMongoClient();
  const databaseName = process.env.MONGODB_DB_NAME ?? "between_us";
  if (!cache.database) {
    const connection = client.connect()
      .then((connectedClient) => connectedClient.db(databaseName))
      .catch(async (error: unknown) => {
        if (cache.client === client) {
          cache.client = undefined;
          cache.database = undefined;
          await client.close().catch(() => {
            console.warn("Failed MongoDB connection could not be closed cleanly");
          });
        }
        throw error;
      });
    cache.database = connection;
  }
  return cache.database;
}