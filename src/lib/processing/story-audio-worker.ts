import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import * as Sentry from "@sentry/node";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import type { ClaimedBackgroundJob } from "@/lib/processing/mongodb-background-job-queue";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { membershipAllows, mongoIdVariants, type GroupMembershipIdentity } from "@/lib/auth/group-access";
import { MongoEventStoryRepository } from "@/lib/repositories/mongodb-event-story-repository";
import { MongoStoryAudioRepository } from "@/lib/repositories/mongodb-story-audio-repository";
import { getElevenLabsStoryAudioSettings, ElevenLabsStoryAudioClient } from "@/lib/integrations/elevenlabs-story-audio";
import { sentryIsEnabled } from "@/lib/observability/sentry-privacy";

const MAX_MIXED_AUDIO_BYTES = 25_000_000;

function captureAudioFailure(
  category: "elevenlabs_audio_generation_failure" | "story_audio_processing_failure",
): void {
  console.error(`Story audio generation failed (${category})`);
  if (!sentryIsEnabled()) return;
  Sentry.withScope((scope) => {
    scope.setTag("category", category);
    Sentry.captureException(new Error("Story audio generation failed"));
  });
}

async function mixAudio(narration: Uint8Array, music: Uint8Array): Promise<Uint8Array> {
  const executable = ffmpegPath;
  if (!executable) throw new Error("Audio mixer is unavailable");
  const directory = await mkdtemp(join(tmpdir(), "betweenus-story-audio-"));
  try {
    const narrationPath = join(directory, "narration.mp3");
    const musicPath = join(directory, "music.mp3");
    const outputPath = join(directory, "story.mp3");
    await Promise.all([
      writeFile(narrationPath, narration),
      writeFile(musicPath, music),
    ]);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, [
        "-hide_banner",
        "-loglevel", "error",
        "-i", narrationPath,
        "-stream_loop", "-1",
        "-i", musicPath,
        "-filter_complex", "[1:a]volume=0.14[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[mix]",
        "-map", "[mix]",
        "-codec:a", "libmp3lame",
        "-b:a", "128k",
        "-y", outputPath,
      ], { stdio: "ignore" });
      child.once("error", reject);
      child.once("close", (code: number | null) => {
        if (code === 0) resolve();
        else reject(new Error("Audio mix operation failed"));
      });
    });
    const bytes = new Uint8Array(await readFile(outputPath));
    if (!bytes.length || bytes.byteLength > MAX_MIXED_AUDIO_BYTES) {
      throw new Error("Mixed story audio is outside the supported size limit");
    }
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function requesterStillBelongsToGroup(input: {
  groupId: string;
  requesterUserId: string;
}): Promise<boolean> {
  if (!ObjectId.isValid(input.groupId)) return false;
  const database = await getMongoDatabase();
  const [group, membership] = await Promise.all([
    database.collection("groups").findOne({ _id: new ObjectId(input.groupId), lifecycleStatus: "active" }),
    database.collection<GroupMembershipIdentity>("group_members").findOne({
      organizationId: { $in: mongoIdVariants(input.groupId) },
      userId: { $in: mongoIdVariants(input.requesterUserId) },
    }),
  ]);
  return Boolean(group && membershipAllows(membership, input.groupId, input.requesterUserId));
}

export async function processEventStoryAudioJob(job: ClaimedBackgroundJob): Promise<void> {
  const database = await getMongoDatabase();
  const audio = new MongoStoryAudioRepository(database);
  const fail = async (category: string) => {
    await audio.markFailed(job.id, category);
  };
  let failureCategory: "elevenlabs_audio_generation_failure" | "story_audio_processing_failure" =
    "story_audio_processing_failure";
  try {
    if (!job.requesterUserId || typeof job.storyRevision !== "number") {
      await fail("story_audio_job_invalid");
      return;
    }
    if (job.attemptCount > 1) {
      await fail("story_audio_retry_requires_review");
      return;
    }
    if (!await requesterStillBelongsToGroup({
      groupId: job.groupId,
      requesterUserId: job.requesterUserId,
    })) {
      await fail("story_audio_requester_unavailable");
      return;
    }

    const story = await new MongoEventStoryRepository(database).find(job.groupId);
    if (!story || story.revision !== job.storyRevision) {
      await fail("story_audio_story_changed");
      return;
    }
    if (!story.narrative.trim() || story.narrative.length > 3_500) {
      await fail("story_audio_story_too_long");
      return;
    }
    const settings = getElevenLabsStoryAudioSettings();
    if (!settings) {
      await fail("story_audio_provider_unavailable");
      return;
    }
    if (!await audio.reserveMonthlyGeneration(settings.monthlyLimit)) {
      await fail("story_audio_monthly_limit");
      return;
    }

    const client = new ElevenLabsStoryAudioClient(settings);
    const estimatedDurationMs = Math.min(180_000, Math.max(30_000, (story.narrative.length / 14) * 1_000));
    failureCategory = "elevenlabs_audio_generation_failure";
    const narration = await Sentry.startSpan(
      { name: "elevenlabs.text-to-speech", op: "ai.inference" },
      () => client.generateNarration(story.narrative),
    );
    const music = await Sentry.startSpan(
      { name: "elevenlabs.music-generation", op: "ai.inference" },
      () => client.generateInstrumental(estimatedDurationMs),
    );
    failureCategory = "story_audio_processing_failure";
    const mixed = await mixAudio(narration, music);
    const currentStory = await new MongoEventStoryRepository(database).find(job.groupId);
    if (!currentStory || currentStory.revision !== job.storyRevision) {
      await fail("story_audio_story_changed");
      return;
    }
    const storedJob = await audio.find(job.id, job.groupId);
    if (!storedJob) throw new Error("Story audio job disappeared during generation");
    await audio.saveAudio(storedJob, mixed);
    await audio.deleteOlderRevisions(job.groupId, job.storyRevision);
  } catch {
    await audio.markFailed(job.id, failureCategory);
    captureAudioFailure(failureCategory);
  }
}
