import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import {
  ElevenLabsClient,
  ElevenLabsApiError,
  getElevenLabsTranscriptionSettings,
  parseVoiceTranscript,
} from "../src/lib/integrations/elevenlabs-client";
import { FragmentInputError } from "../src/lib/ingestion/fragment-validation";
import { validateVoiceClip } from "../src/lib/ingestion/voice-validation";
import { hasApprovedTextSource } from "../src/lib/domain/memory";
import { MongoVoiceRepository } from "../src/lib/repositories/mongodb-voice-repository";

function makeWav(durationSeconds: number): Uint8Array {
  const dataBytes = durationSeconds * 32_000;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const setAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  setAscii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  setAscii(8, "WAVE");
  setAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  setAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes;
}

test("voice audio is validated from WAV bytes and exact duration bounds", () => {
  const clip = validateVoiceClip(makeWav(2.5), "audio/wav");
  assert.equal(clip.durationSeconds, 2.5);
  assert.equal(clip.mimeType, "audio/wav");
  assert.equal(validateVoiceClip(makeWav(60), "audio/wav").durationSeconds, 60);
  assert.throws(() => validateVoiceClip(makeWav(60.5), "audio/wav"), FragmentInputError);
  assert.throws(() => validateVoiceClip(makeWav(1), "audio/mpeg"), FragmentInputError);
  assert.throws(() => validateVoiceClip(new Uint8Array(44), "audio/wav"), FragmentInputError);
});

test("voice transcripts are not text evidence until reviewed by their author", () => {
  const transcript = {
    type: "voice" as const,
    source: "upload" as const,
    textContent: "Let's meet at the park.",
  };
  assert.equal(hasApprovedTextSource(transcript), false);
  assert.equal(hasApprovedTextSource({
    ...transcript,
    transcriptReviewedAt: "2026-10-04T12:00:00Z",
  }), true);
  assert.equal(hasApprovedTextSource({
    ...transcript,
    transcriptReviewedAt: "invalid",
  }), false);
});

test("ElevenLabs stays disabled until a key and non-zero bounded monthly caps exist", () => {
  assert.equal(getElevenLabsTranscriptionSettings({}), null);
  assert.equal(getElevenLabsTranscriptionSettings({
    ELEVENLABS_TRANSCRIPTION_ENABLED: "true",
    ELEVENLABS_API_KEY: "secret",
    ELEVENLABS_MONTHLY_SECONDS: "0",
    ELEVENLABS_MONTHLY_REQUESTS: "1",
  }), null);
  assert.deepEqual(getElevenLabsTranscriptionSettings({
    ELEVENLABS_TRANSCRIPTION_ENABLED: "true",
    ELEVENLABS_API_KEY: "  secret  ",
    ELEVENLABS_MONTHLY_SECONDS: "120",
    ELEVENLABS_MONTHLY_REQUESTS: "3",
  }), {
    apiKey: "secret",
    timeoutMs: 60_000,
    monthlySeconds: 120,
    monthlyRequests: 3,
  });
  assert.equal(getElevenLabsTranscriptionSettings({
    ELEVENLABS_TRANSCRIPTION_ENABLED: "true",
    ELEVENLABS_API_KEY: "secret",
    ELEVENLABS_MONTHLY_SECONDS: "3601",
    ELEVENLABS_MONTHLY_REQUESTS: "3",
  }), null);
});

test("Scribe request sends only WAV bytes and minimal word-timestamp options", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const client = new ElevenLabsClient({
    apiKey: "secret-key",
    timeoutMs: 10_000,
    monthlySeconds: 120,
    monthlyRequests: 3,
  }, async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({
      text: "Meet at the park.",
      language_code: "eng",
      words: [
        { text: "Meet", start: 0.1, end: 0.4, speaker_id: "speaker_0" },
        { text: "at", start: 0.41, end: 0.5, speaker_id: "speaker_0" },
      ],
    });
  });

  const result = await client.transcribe({ bytes: makeWav(1) });
  assert.equal(requestUrl, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(new Headers(requestInit?.headers).get("xi-api-key"), "secret-key");
  assert.equal(requestInit?.method, "POST");
  assert.ok(requestInit?.body instanceof FormData);
  const form = requestInit.body as FormData;
  assert.equal(form.get("model_id"), "scribe_v2");
  assert.equal(form.get("timestamps_granularity"), "word");
  assert.equal(form.get("diarize"), "false");
  assert.equal(form.get("tag_audio_events"), "false");
  assert.deepEqual([...form.keys()].sort(), ["diarize", "file", "model_id", "tag_audio_events", "timestamps_granularity"]);
  assert.equal(result.text, "Meet at the park.");
  assert.equal(result.words[0].start, 0.1);
  assert.equal(result.words[0].speakerId, "speaker_0");
});

test("malformed Scribe response and provider error bodies are not accepted or exposed", async () => {
  assert.throws(
    () => parseVoiceTranscript({ text: "spoken words", words: [{ text: "bad", start: 2, end: 1 }] }),
    ElevenLabsApiError,
  );
  const client = new ElevenLabsClient({
    apiKey: "secret-key",
    timeoutMs: 10_000,
    monthlySeconds: 120,
    monthlyRequests: 3,
  }, async () => new Response("sensitive upstream response", { status: 429 }));
  await assert.rejects(client.transcribe({ bytes: makeWav(1) }), (error: unknown) => {
    assert.ok(error instanceof ElevenLabsApiError);
    assert.equal(error.statusCode, 429);
    assert.equal(error.message.includes("sensitive"), false);
    return true;
  });
});

function makeUsageDatabase() {
  const documents = new Map<string, Record<string, unknown>>();
  const client = {
    startSession() {
      return {
        withTransaction: async (callback: () => Promise<void>) => callback(),
        endSession: async () => undefined,
      };
    },
  };
  const database = {
    client,
    collection(name: string) {
      if (name === "voice_transcripts") return {};
      if (name !== "voice_transcription_usage") throw new Error(`Unexpected collection: ${name}`);
      return {
        findOne: async (filter: Record<string, unknown>) =>
          documents.get(String(filter._id)) ?? null,
        updateOne: async (
          filter: Record<string, unknown>,
          update: Record<string, unknown>,
          options?: { upsert?: boolean },
        ) => {
          const key = String(filter._id);
          const current = documents.get(key);
          const expression = filter.$expr as {
            $and: Array<{ $lte?: unknown[]; $lt?: unknown[] }>;
          } | undefined;
          if (current && expression) {
            const secondsCheck = expression.$and[0].$lte?.[1] as number;
            const requestCheck = expression.$and[1].$lt?.[1] as number;
            if (
              Number(current.reservedSeconds ?? 0) + Number((update.$inc as Record<string, number>).reservedSeconds) > secondsCheck ||
              Number(current.reservedRequests ?? 0) >= requestCheck
            ) return { matchedCount: 0, upsertedCount: 0 };
          }
          const increment = update.$inc as Record<string, number>;
          const setOnInsert = update.$setOnInsert as Record<string, unknown>;
          if (current) {
            current.reservedSeconds = Number(current.reservedSeconds ?? 0) + increment.reservedSeconds;
            current.reservedRequests = Number(current.reservedRequests ?? 0) + increment.reservedRequests;
            return { matchedCount: 1, upsertedCount: 0 };
          }
          if (!options?.upsert) return { matchedCount: 0, upsertedCount: 0 };
          documents.set(key, {
            _id: key,
            ...setOnInsert,
            reservedSeconds: increment.reservedSeconds,
            reservedRequests: increment.reservedRequests,
          });
          return { matchedCount: 0, upsertedCount: 1 };
        },
        insertOne: async (document: Record<string, unknown>) => {
          const key = String(document._id);
          if (documents.has(key)) throw Object.assign(new Error("duplicate"), { code: 11000 });
          documents.set(key, document);
          return { acknowledged: true };
        },
        deleteOne: async (filter: Record<string, unknown>) => {
          const key = String(filter._id);
          const existed = documents.delete(key);
          return { deletedCount: existed ? 1 : 0 };
        },
      };
    },
  };
  return { database: database as unknown as Db, documents };
}

test("monthly transcription reservations are atomic, idempotent, and releasable before dispatch", async () => {
  const { database, documents } = makeUsageDatabase();
  const repository = new MongoVoiceRepository(database);
  const budget = {
    monthlySeconds: 5,
    monthlyRequests: 1,
    now: new Date("2026-10-04T12:00:00Z"),
  };
  assert.equal(await repository.reserveMonthlyUsage({
    ...budget,
    fragmentId: "fragment-a",
    seconds: 3,
  }), "reserved");
  assert.equal(await repository.reserveMonthlyUsage({
    ...budget,
    fragmentId: "fragment-a",
    seconds: 3,
  }), "already_reserved");
  assert.equal(await repository.reserveMonthlyUsage({
    ...budget,
    fragmentId: "fragment-b",
    seconds: 2,
  }), "exhausted");
  const total = documents.get("month:2026-10");
  assert.equal(total?.reservedSeconds, 3);
  assert.equal(total?.reservedRequests, 1);

  await repository.releaseMonthlyUsage("fragment-a");
  assert.equal(total?.reservedSeconds, 0);
  assert.equal(total?.reservedRequests, 0);
  assert.equal(await repository.reserveMonthlyUsage({
    ...budget,
    fragmentId: "fragment-b",
    seconds: 5,
  }), "reserved");
});
