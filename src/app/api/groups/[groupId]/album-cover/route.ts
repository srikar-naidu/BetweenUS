import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { FragmentInputError } from "@/lib/ingestion/fragment-validation";
import { MAX_IMAGE_FILE_BYTES, validateAlbumCover } from "@/lib/ingestion/media-validation";
import {
  MongoAlbumCoverStorage,
  type AlbumCoverReference,
} from "@/lib/repositories/mongodb-album-cover-storage";

export const runtime = "nodejs";

const isAlbumCoverReference = (value: unknown): value is AlbumCoverReference =>
  typeof value === "object" &&
  value !== null &&
  "storageId" in value &&
  typeof value.storageId === "string" &&
  "mimeType" in value &&
  (value.mimeType === "image/jpeg" || value.mimeType === "image/png" || value.mimeType === "image/webp") &&
  "fileSizeBytes" in value &&
  typeof value.fileSizeBytes === "number" &&
  value.fileSizeBytes > 0 &&
  value.fileSizeBytes <= MAX_IMAGE_FILE_BYTES;

async function readPhoto(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new FragmentInputError("Choose an image for the album cover");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_FILE_BYTES) {
        await reader.cancel();
        throw new FragmentInputError("Album cover images must be smaller than 12 MB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { group } = await requireGroupMembership(request.headers, groupId);
    if (!isAlbumCoverReference(group.albumCover)) {
      return Response.json({ error: "Album cover not found" }, { status: 404 });
    }
    const stored = await new MongoAlbumCoverStorage(await getMongoDatabase()).load({
      storageId: group.albumCover.storageId,
      groupId,
      maximumBytes: MAX_IMAGE_FILE_BYTES,
    });
    if (!stored || stored.mimeType !== group.albumCover.mimeType) {
      return Response.json({ error: "Album cover not found" }, { status: 404 });
    }
    return new Response(new Uint8Array(stored.bytes), {
      headers: {
        "Content-Disposition": "inline",
        "Content-Type": stored.mimeType,
        "Content-Length": String(stored.bytes.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { group } = await requireGroupMembership(request.headers, groupId, ["owner", "admin"]);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_IMAGE_FILE_BYTES) {
      return Response.json({ error: "Album cover images must be smaller than 12 MB" }, { status: 413 });
    }
    const bytes = await readPhoto(request);
    const media = validateAlbumCover(bytes, request.headers.get("content-type") ?? "");

    const database = await getMongoDatabase();
    const storage = new MongoAlbumCoverStorage(database);
    const nextCover = await storage.save(bytes, { groupId, media });
    const update = await database.collection("groups").updateOne(
      { _id: group._id, lifecycleStatus: "active" },
      { $set: { albumCover: nextCover } },
    );
    if (update.matchedCount !== 1) {
      await storage.delete(nextCover.storageId, groupId);
      return Response.json({ error: "Album not found" }, { status: 404 });
    }

    if (isAlbumCoverReference(group.albumCover)) {
      await storage.delete(group.albumCover.storageId, groupId);
    }
    return Response.json({ status: "saved" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
