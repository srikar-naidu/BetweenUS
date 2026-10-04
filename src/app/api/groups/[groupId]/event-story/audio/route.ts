import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { getElevenLabsStoryAudioSettings } from "@/lib/integrations/elevenlabs-story-audio";
import { MongoEventStoryRepository } from "@/lib/repositories/mongodb-event-story-repository";
import { MongoStoryAudioRepository } from "@/lib/repositories/mongodb-story-audio-repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    await requireGroupMembership(request.headers, groupId);
    const database = await getMongoDatabase();
    const story = await new MongoEventStoryRepository(database).find(groupId);
    if (!story) {
      return Response.json({
        configured: getElevenLabsStoryAudioSettings() !== null,
        job: null,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const jobs = new MongoStoryAudioRepository(database);
    const job = await jobs.findActiveOrLatestForRevision(groupId, story.revision);
    return Response.json({
      configured: getElevenLabsStoryAudioSettings() !== null,
      storyRevision: story.revision,
      job: job ? {
        id: job.id,
        status: job.status,
        errorCategory: job.errorCategory,
        ...(job.status === "succeeded"
          ? { audioUrl: `/api/groups/${encodeURIComponent(groupId)}/event-story/audio/file?jobId=${encodeURIComponent(job.id)}` }
          : {}),
      } : null,
    }, { headers: { "Cache-Control": "no-store" } });
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
    const { session } = await requireGroupMembership(request.headers, groupId);
    const body: unknown = await request.json().catch(() => null);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      (body as Record<string, unknown>).externalProcessingConsent !== true
    ) {
      return Response.json({
        error: "Confirm that the story text may be sent to ElevenLabs to create narration.",
      }, { status: 400 });
    }
    const requestId = request.headers.get("Idempotency-Key");
    if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
      return Response.json({ error: "A UUID Idempotency-Key is required" }, { status: 400 });
    }
    const settings = getElevenLabsStoryAudioSettings();
    if (!settings) {
      return Response.json({ error: "Story audio generation is not configured on this server" }, { status: 503 });
    }
    const database = await getMongoDatabase();
    const story = await new MongoEventStoryRepository(database).find(groupId);
    if (!story || !story.narrative.trim()) {
      return Response.json({ error: "Save a story before creating its audio version" }, { status: 409 });
    }
    if (story.narrative.length > 3_500) {
      return Response.json({
        error: "This story is too long for the current audio export limit. Shorten it to 3,500 characters or fewer.",
      }, { status: 413 });
    }

    const repository = new MongoStoryAudioRepository(database);
    const existingAudio = await repository.findActiveOrLatestForRevision(groupId, story.revision);
    if (existingAudio && existingAudio.status !== "failed") {
      return Response.json({
        jobId: existingAudio.id,
        status: existingAudio.status,
        ...(existingAudio.status === "succeeded" ? {
          audioUrl: `/api/groups/${encodeURIComponent(groupId)}/event-story/audio/file?jobId=${encodeURIComponent(existingAudio.id)}`,
        } : {}),
      }, { status: 200, headers: { "Cache-Control": "no-store" } });
    }
    const { job } = await repository.createOrFind({
      groupId,
      requesterUserId: session.user.id,
      storyRevision: story.revision,
      requestId,
    });
    return Response.json(
      { jobId: job.id, status: job.status },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
