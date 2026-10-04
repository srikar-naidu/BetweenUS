import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoStoryAudioRepository } from "@/lib/repositories/mongodb-story-audio-repository";

export const runtime = "nodejs";

function streamChunkBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new TypeError("Story audio stream returned an unsupported chunk");
}

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    await requireGroupMembership(request.headers, groupId);
    const jobId = new URL(request.url).searchParams.get("jobId");
    if (!jobId || jobId.length > 512) {
      return Response.json({ error: "Story audio was not found" }, { status: 404 });
    }
    const stream = await new MongoStoryAudioRepository(await getMongoDatabase())
      .openAudio(jobId, groupId);
    if (!stream) return Response.json({ error: "Story audio was not found" }, { status: 404 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = streamChunkBytes(chunk);
      size += bytes.byteLength;
      if (size > 25_000_000) {
        return Response.json({ error: "Story audio exceeds the supported size limit" }, { status: 413 });
      }
      chunks.push(bytes);
    }
    const audio = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(audio, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
