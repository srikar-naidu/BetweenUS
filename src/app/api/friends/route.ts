import { createHash } from "node:crypto";
import type { Collection, Db, Document } from "mongodb";
import { apiErrorResponse } from "@/lib/api/errors";
import { getAuth } from "@/lib/auth";
import { getMongoDatabase } from "@/lib/db/mongodb";
import type { FriendConnection, FriendProfile } from "@/lib/domain/memory";

export const runtime = "nodejs";

type StoredConnection = Omit<FriendConnection, "id"> & { _id: string } & Document;
type UserRecord = Document & {
  _id: string;
  name?: string;
  image?: string | null;
  discoverable?: boolean;
};

const globalForFriendIndexes = globalThis as typeof globalThis & {
  betweenUsFriendIndexes?: WeakMap<Db, Promise<void>>;
};
const friendIndexes = (globalForFriendIndexes.betweenUsFriendIndexes ??= new WeakMap());

function connectionId(firstId: string, secondId: string): string {
  return createHash("sha256")
    .update([firstId, secondId].sort().join("\0"))
    .digest("hex");
}

function profile(user: UserRecord): FriendProfile {
  return {
    id: String(user._id),
    name: typeof user.name === "string" && user.name.trim() ? user.name.trim() : "Between Us member",
    image: typeof user.image === "string" ? user.image : null,
  };
}

async function getSession(request: Request) {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  return session;
}

async function ensureIndexes(database: Db, collection: Collection<StoredConnection>): Promise<void> {
  let pending = friendIndexes.get(database);
  if (!pending) {
    pending = Promise.all([
      collection.createIndex({ requesterId: 1, status: 1, updatedAt: -1 }),
      collection.createIndex({ recipientId: 1, status: 1, updatedAt: -1 }),
    ]).then(() => undefined);
    friendIndexes.set(database, pending);
  }
  try {
    await pending;
  } catch (error) {
    friendIndexes.delete(database);
    throw error;
  }
}

export async function GET(request: Request) {
  try {
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in is required" }, { status: 401 });
    const database = await getMongoDatabase();
    const users = database.collection<UserRecord>("users");
    const connections = database.collection<StoredConnection>("friend_connections");
    await ensureIndexes(database, connections);
    const currentUserId = session.user.id;
    const current = await users.findOne({ _id: currentUserId });
    const allConnections = await connections.find({
      $or: [{ requesterId: currentUserId }, { recipientId: currentUserId }],
    }).sort({ updatedAt: -1 }).limit(500).toArray();
    const connectedIds = new Set(allConnections.flatMap((item) => [item.requesterId, item.recipientId]));
    connectedIds.delete(currentUserId);
    const relatedUsers = await users.find({ _id: { $in: [...connectedIds] } }).toArray();
    const profileById = new Map(relatedUsers.map((user) => [String(user._id), profile(user)]));
    const accepted: FriendProfile[] = [];
    const incomingRequests: FriendProfile[] = [];
    const outgoingRequests: FriendProfile[] = [];
    for (const connection of allConnections) {
      const otherId = connection.requesterId === currentUserId
        ? connection.recipientId
        : connection.requesterId;
      const other = profileById.get(otherId);
      if (!other) continue;
      if (connection.status === "accepted") accepted.push(other);
      else if (connection.recipientId === currentUserId) incomingRequests.push(other);
      else outgoingRequests.push(other);
    }

    const search = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    let results: FriendProfile[] = [];
    if (search.length >= 2) {
      const escaped = search.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const candidates = await users.find({
        _id: { $ne: currentUserId },
        discoverable: true,
        name: { $regex: escaped, $options: "i" },
      }).project<UserRecord>({ _id: 1, name: 1, image: 1 }).limit(30).toArray();
      results = candidates
        .map(profile)
        .filter((candidate) => !connectedIds.has(candidate.id));
    }
    return Response.json({
      discoverable: current?.discoverable === true,
      friends: accepted,
      incomingRequests,
      outgoingRequests,
      results,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in is required" }, { status: 401 });
    const body: unknown = await request.json().catch(() => null);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).friendId !== "string"
    ) {
      return Response.json({ error: "Choose a member to connect with" }, { status: 400 });
    }
    const friendId = ((body as Record<string, string>).friendId).trim();
    if (!friendId || friendId === session.user.id || friendId.length > 160) {
      return Response.json({ error: "That member cannot be added" }, { status: 400 });
    }
    const database = await getMongoDatabase();
    const users = database.collection<UserRecord>("users");
    const target = await users.findOne({ _id: friendId, discoverable: true }, { projection: { _id: 1 } });
    if (!target) return Response.json({ error: "Member not found" }, { status: 404 });

    const collection = database.collection<StoredConnection>("friend_connections");
    await ensureIndexes(database, collection);
    const id = connectionId(session.user.id, friendId);
    const existing = await collection.findOne({ _id: id });
    if (existing) {
      if (existing.status === "accepted") {
        return Response.json({ status: "accepted" }, { headers: { "Cache-Control": "no-store" } });
      }
      return Response.json(
        { error: existing.requesterId === session.user.id ? "Friend request already sent" : "This person already requested to connect with you" },
        { status: 409 },
      );
    }
    const now = new Date();
    await collection.insertOne({
      _id: id,
      requesterId: session.user.id,
      recipientId: friendId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    return Response.json({ status: "pending" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in is required" }, { status: 401 });
    const body: unknown = await request.json().catch(() => null);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).friendId !== "string" ||
      !["accept", "decline", "remove"].includes(String((body as Record<string, unknown>).action))
    ) {
      return Response.json({ error: "Invalid friend action" }, { status: 400 });
    }
    const { friendId, action } = body as { friendId: string; action: "accept" | "decline" | "remove" };
    const database = await getMongoDatabase();
    const collection = database.collection<StoredConnection>("friend_connections");
    await ensureIndexes(database, collection);
    const filter = { _id: connectionId(session.user.id, friendId) };
    const existing = await collection.findOne(filter);
    if (!existing) return Response.json({ error: "Friend request not found" }, { status: 404 });
    if (action === "accept") {
      if (existing.status !== "pending" || existing.recipientId !== session.user.id) {
        return Response.json({ error: "Only the recipient can accept this request" }, { status: 403 });
      }
      await collection.updateOne(filter, { $set: { status: "accepted", updatedAt: new Date() } });
    } else if (action === "decline") {
      if (existing.status !== "pending" || existing.recipientId !== session.user.id) {
        return Response.json({ error: "Only the recipient can decline this request" }, { status: 403 });
      }
      await collection.deleteOne(filter);
    } else {
      if (existing.requesterId !== session.user.id && existing.recipientId !== session.user.id) {
        return Response.json({ error: "Friend connection not found" }, { status: 404 });
      }
      await collection.deleteOne(filter);
    }
    return Response.json({ status: action === "accept" ? "accepted" : "removed" }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await getSession(request);
    if (!session) return Response.json({ error: "Sign in is required" }, { status: 401 });
    const body: unknown = await request.json().catch(() => null);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).discoverable !== "boolean"
    ) {
      return Response.json({ error: "Choose whether people can find you" }, { status: 400 });
    }
    const database = await getMongoDatabase();
    await database.collection<UserRecord>("users").updateOne(
      { _id: session.user.id },
      { $set: { discoverable: (body as { discoverable: boolean }).discoverable } },
    );
    return Response.json({ discoverable: (body as { discoverable: boolean }).discoverable }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
