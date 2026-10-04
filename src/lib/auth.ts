import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { organization } from "better-auth/plugins";
import type { Db } from "mongodb";
import { getMongoClient, getMongoDatabase } from "@/lib/db/mongodb";

type AuthInstance = Awaited<ReturnType<typeof createAuth>>;

interface AuthCache {
  instance?: AuthInstance;
  pending?: Promise<AuthInstance>;
}

const globalForAuth = globalThis as typeof globalThis & {
  betweenUsAuth?: AuthCache;
};

const cache = (globalForAuth.betweenUsAuth ??= {});

const pluralizedOrganizationCollections = [
  ["groupss", "groups"],
  ["group_memberss", "group_members"],
  ["group_invitationss", "group_invitations"],
] as const;

async function migratePluralizedOrganizationCollections(database: Db): Promise<void> {
  const migrationId = "better-auth-organization-collection-names-v1";
  const migrations = database.collection<{ _id: string; status: string }>("betweenus_migrations");
  const completed = await migrations.findOne({ _id: migrationId, status: "completed" });
  if (completed) return;

  for (const [sourceName, targetName] of pluralizedOrganizationCollections) {
    const sourceExists = await database.listCollections(
      { name: sourceName },
      { nameOnly: true },
    ).hasNext();
    if (!sourceExists) continue;

    await database.collection(sourceName).aggregate([
      {
        $merge: {
          into: targetName,
          on: "_id",
          whenMatched: "keepExisting",
          whenNotMatched: "insert",
        },
      },
    ]).toArray();
  }

  await migrations.updateOne(
    { _id: migrationId },
    { $set: { status: "completed" } },
    { upsert: true },
  );
}

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

type AuthEnvironment = {
  [key: string]: string | undefined;
  MONGODB_URI?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export function getAuthConfigurationStatus(environment: AuthEnvironment = process.env) {
  const missing = [
    ["MONGODB_URI", environment.MONGODB_URI],
    ["BETTER_AUTH_SECRET", environment.BETTER_AUTH_SECRET],
    ["BETTER_AUTH_URL", environment.BETTER_AUTH_URL],
    ["GOOGLE_CLIENT_ID", environment.GOOGLE_CLIENT_ID],
    ["GOOGLE_CLIENT_SECRET", environment.GOOGLE_CLIENT_SECRET],
  ]
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  const invalid: string[] = [];
  const mongoUri = environment.MONGODB_URI?.trim();
  const authUrl = environment.BETTER_AUTH_URL?.trim();
  const authSecret = environment.BETTER_AUTH_SECRET;

  if (mongoUri) {
    try {
      const parsed = new URL(mongoUri);
      if (!["mongodb:", "mongodb+srv:"].includes(parsed.protocol) || !parsed.hostname) {
        invalid.push("MONGODB_URI");
      }
    } catch {
      invalid.push("MONGODB_URI");
    }
  }
  if (authUrl) {
    try {
      const parsed = new URL(authUrl);
      if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
        invalid.push("BETTER_AUTH_URL");
      }
    } catch {
      invalid.push("BETTER_AUTH_URL");
    }
  }
  if (authSecret && Buffer.byteLength(authSecret, "utf8") < 32) {
    invalid.push("BETTER_AUTH_SECRET");
  }

  return { configured: missing.length === 0 && invalid.length === 0, missing, invalid };
}

export async function getAuth(): Promise<AuthInstance> {
  if (cache.instance) return cache.instance;

  const status = getAuthConfigurationStatus();
  if (!status.configured) {
    const problems = [...status.missing, ...status.invalid];
    throw new AuthConfigurationError(
      `Authentication configuration is invalid: ${problems.join(", ")}`,
    );
  }

  if (!cache.pending) cache.pending = createAuth();
  const pending = cache.pending;
  try {
    const instance = await pending;
    cache.instance = instance;
    return instance;
  } catch (error) {
    if (cache.pending === pending) cache.pending = undefined;
    throw error;
  }
}

async function createAuth() {
  const database = await getMongoDatabase();
  const client = getMongoClient();
  await migratePluralizedOrganizationCollections(database);

  return betterAuth({
    appName: "Between Us",
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: mongodbAdapter(database, { client, usePlural: true }),
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      },
    },
    plugins: [
      organization({
        requireEmailVerificationOnInvitation: true,
        invitationExpiresIn: 60 * 60 * 24 * 7,
        async sendInvitationEmail({ id, organization }) {
          await database
            .collection<{
              _id: string;
              organizationId: string;
              deliveryMode: string;
              createdAt: Date;
            }>("group_invitation_deliveries")
            .updateOne(
            { _id: id },
            {
              $setOnInsert: {
                _id: id,
                organizationId: organization.id,
                deliveryMode: "manual_link",
                createdAt: new Date(),
              },
            },
            { upsert: true },
          );
        },
        schema: {
          organization: {
            modelName: "group",
            additionalFields: {
              description: { type: "string", required: false, input: true },
              lifecycleStatus: {
                type: "string",
                required: false,
                defaultValue: "active",
                input: false,
              },
              backboardAssistantId: {
                type: "string",
                required: false,
                input: false,
              },
            },
          },
          member: { modelName: "group_member" },
          invitation: { modelName: "group_invitation" },
        },
      }),
    ],
  });
}