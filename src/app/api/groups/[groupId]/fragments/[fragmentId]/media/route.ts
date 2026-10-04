import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import {
  MAX_IMAGE_FILE_BYTES,
  MAX_VIDEO_FILE_BYTES,
} from "@/lib/ingestion/media-validation";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoGroupMediaStorage } from "@/lib/repositories/mongodb-group-media-storage";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string; fragmentId: string }> },
) {
  try {
    const { groupId, fragmentId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    const database = await getMongoDatabase();
    const fragment = await new MongoMemoryRepository(database).findFragmentVisibleToMember(
      groupId,
      fragmentId,
      session.user.id,
    );
    if (
      !fragment ||
      (fragment.type !== "image" && fragment.type !== "video") ||
      fragment.source !== "upload" ||
      fragment.deletionState !== "active" ||
      !fragment.storageUri ||
      (fragment.visibility !== "group" && fragment.authorUserId !== session.user.id)
    ) {
      return Response.json({ error: "Media not found" }, { status: 404 });
    }
    const maximumBytes = fragment.type === "image" ? MAX_IMAGE_FILE_BYTES : MAX_VIDEO_FILE_BYTES;
    const stored = await new MongoGroupMediaStorage(database).load({
      storageUri: fragment.storageUri,
      groupId,
      fragmentId,
      authorUserId: fragment.authorUserId,
      maximumBytes,
    });
    if (!stored) return Response.json({ error: "Media not found" }, { status: 404 });
    const allowedMimeTypes = fragment.type === "image"
      ? new Set(["image/jpeg", "image/png", "image/webp"])
      : new Set(["video/mp4", "video/webm"]);
    if (!allowedMimeTypes.has(stored.mimeType)) {
      return Response.json({ error: "Media not found" }, { status: 404 });
    }
    return new Response(new Uint8Array(stored.bytes), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Length": String(stored.bytes.byteLength),
        "Content-Type": stored.mimeType,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
