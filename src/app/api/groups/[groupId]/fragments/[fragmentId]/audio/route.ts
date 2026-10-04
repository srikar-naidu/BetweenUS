import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MAX_VOICE_FILE_BYTES } from "@/lib/ingestion/voice-validation";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoVoiceStorage } from "@/lib/repositories/mongodb-voice-storage";

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
      fragment.type !== "voice" ||
      fragment.deletionState !== "active" ||
      !fragment.storageUri ||
      (fragment.visibility !== "group" && fragment.authorUserId !== session.user.id)
    ) {
      return Response.json({ error: "Voice note not found" }, { status: 404 });
    }
    const bytes = await new MongoVoiceStorage(database).load({
      storageUri: fragment.storageUri,
      groupId,
      fragmentId,
      authorUserId: fragment.authorUserId,
      maximumBytes: MAX_VOICE_FILE_BYTES,
    });
    if (!bytes) return Response.json({ error: "Voice note not found" }, { status: 404 });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Length": String(bytes.byteLength),
        "Content-Type": "audio/wav",
        "Content-Disposition": 'inline; filename="voice-note.wav"',
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
