import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { organization } from "better-auth/plugins";
import { getMongoClient } from "@/lib/db/mongodb";

type AuthInstance = Awaited<ReturnType<typeof createAuth>>;

interface AuthCache {
  instance?: AuthInstance;
  pending?: Promise<AuthInstance>;
}

const globalForAuth = globalThis as typeof globalThis & {
  betweenUsAuth?: AuthCache;
};

const cache = (globalForAuth.betweenUsAuth ??= {});

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

export function getAuthConfigurationStatus() {
  const missing = [
    ["MONGODB_URI", process.env.MONGODB_URI],
    ["BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET],
    ["BETTER_AUTH_URL", process.env.BETTER_AUTH_URL],
    ["GOOGLE_CLIENT_ID", process.env.GOOGLE_CLIENT_ID],
    ["GOOGLE_CLIENT_SECRET", process.env.GOOGLE_CLIENT_SECRET],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  return { configured: missing.length === 0, missing };
}

export async function getAuth(): Promise<AuthInstance> {
  if (cache.instance) return cache.instance;

  const status = getAuthConfigurationStatus();
  if (!status.configured) {
    throw new AuthConfigurationError(
      `Authentication is not configured. Missing: ${status.missing.join(", ")}`,
    );
  }

  cache.pending ??= createAuth();
  cache.instance = await cache.pending;
  return cache.instance;
}

async function createAuth() {
  const client = getMongoClient();
  await client.connect();
  const database = client.db(process.env.MONGODB_DB_NAME ?? "between_us");

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
            modelName: "groups",
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
          member: { modelName: "group_members" },
          invitation: { modelName: "group_invitations" },
        },
      }),
    ],
  });
}