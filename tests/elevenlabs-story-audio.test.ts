import assert from "node:assert/strict";
import test from "node:test";
import {
  ElevenLabsStoryAudioClient,
  ElevenLabsStoryAudioError,
  getElevenLabsStoryAudioSettings,
} from "../src/lib/integrations/elevenlabs-story-audio";

const settings = {
  apiKey: "server-only-test-key",
  voiceId: "test-voice",
  timeoutMs: 1_000,
  monthlyLimit: 10,
};

test("story audio settings require enabled flag and bounded server configuration", () => {
  assert.equal(getElevenLabsStoryAudioSettings({ ELEVENLABS_API_KEY: "key" }), null);
  assert.equal(getElevenLabsStoryAudioSettings({
    ELEVENLABS_STORY_AUDIO_ENABLED: "true",
    ELEVENLABS_API_KEY: "key",
    ELEVENLABS_STORY_AUDIO_VOICE_ID: "voice",
    ELEVENLABS_STORY_AUDIO_TIMEOUT_MS: "999999",
  }), null);
  assert.deepEqual(getElevenLabsStoryAudioSettings({
    ELEVENLABS_STORY_AUDIO_ENABLED: "true",
    ELEVENLABS_API_KEY: " key ",
    ELEVENLABS_STORY_AUDIO_VOICE_ID: " voice ",
  }), {
    apiKey: "key",
    voiceId: "voice",
    timeoutMs: 180_000,
    monthlyLimit: 10,
  });
});

test("narration uses the configured voice, protected key, and the approved story text", async () => {
  let call: { url: string; init: RequestInit } | null = null;
  const client = new ElevenLabsStoryAudioClient(settings, async (input, init = {}) => {
    call = { url: String(input), init };
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "Content-Type": "audio/mpeg" },
    });
  });

  assert.deepEqual(await client.generateNarration("Our picnic by the lake."), new Uint8Array([1, 2, 3]));
  assert.ok(call);
  const request = call as { url: string; init: RequestInit };
  assert.match(request.url, /\/v1\/text-to-speech\/test-voice\?/);
  assert.equal(new Headers(request.init.headers).get("xi-api-key"), settings.apiKey);
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    text: "Our picnic by the lake.",
    model_id: "eleven_multilingual_v2",
    voice_settings: {
      stability: 0.32,
      similarity_boost: 0.75,
      style: 0.65,
      speed: 0.92,
      use_speaker_boost: true,
    },
  });
});

test("music uses a bounded generic instrumental prompt without story text", async () => {
  let call: { url: string; init: RequestInit } | null = null;
  const client = new ElevenLabsStoryAudioClient(settings, async (input, init = {}) => {
    call = { url: String(input), init };
    return new Response(new Uint8Array([4, 5]), {
      headers: { "Content-Type": "audio/mpeg" },
    });
  });

  assert.deepEqual(await client.generateInstrumental(500_000), new Uint8Array([4, 5]));
  assert.ok(call);
  const request = call as { url: string; init: RequestInit };
  assert.match(request.url, /\/v1\/music\?/);
  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.music_length_ms, 180_000);
  assert.equal(body.model_id, "music_v2_5");
  assert.equal(body.force_instrumental, true);
  assert.equal(typeof body.prompt, "string");
  assert.equal(String(body.prompt).includes("Our picnic by the lake."), false);
});

test("free-form or oversized provider responses are rejected without returning response content", async () => {
  const invalid = new ElevenLabsStoryAudioClient(settings, async () =>
    new Response("not an audio response", { headers: { "Content-Type": "application/json" } }),
  );
  await assert.rejects(
    invalid.generateNarration("A short story."),
    (error: unknown) => error instanceof ElevenLabsStoryAudioError && error.statusCode === 200,
  );

  const oversized = new ElevenLabsStoryAudioClient(settings, async () =>
    new Response(new Uint8Array([1]), {
      headers: { "Content-Type": "audio/mpeg", "Content-Length": "12000001" },
    }),
  );
  await assert.rejects(
    oversized.generateNarration("A short story."),
    (error: unknown) => error instanceof ElevenLabsStoryAudioError &&
      !error.message.includes("provider"),
  );
});

test("provider failures do not expose response bodies, URLs, or keys", async () => {
  const client = new ElevenLabsStoryAudioClient(settings, async () =>
    new Response("private provider error", { status: 500 }),
  );
  await assert.rejects(
    client.generateNarration("A short story."),
    (error: unknown) => error instanceof ElevenLabsStoryAudioError &&
      error.statusCode === 500 &&
      !error.message.includes("private") &&
      !error.message.includes(settings.apiKey),
  );
});
