export interface ElevenLabsStoryAudioSettings {
  apiKey: string;
  voiceId: string;
  timeoutMs: number;
  monthlyLimit: number;
}

export class ElevenLabsStoryAudioError extends Error {
  constructor(public readonly statusCode: number | null) {
    super("ElevenLabs story audio generation failed");
    this.name = "ElevenLabsStoryAudioError";
  }
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : 0;
}

export function getElevenLabsStoryAudioSettings(
  environment: RuntimeEnvironment = process.env,
): ElevenLabsStoryAudioSettings | null {
  if (environment.ELEVENLABS_STORY_AUDIO_ENABLED !== "true") return null;
  const apiKey = environment.ELEVENLABS_API_KEY?.trim();
  const voiceId = environment.ELEVENLABS_STORY_AUDIO_VOICE_ID?.trim();
  const timeoutMs = boundedInteger(environment.ELEVENLABS_STORY_AUDIO_TIMEOUT_MS, 180_000, 180_000);
  const monthlyLimit = boundedInteger(environment.ELEVENLABS_STORY_AUDIO_MONTHLY_LIMIT, 10, 30);
  if (!apiKey || !voiceId || !timeoutMs || !monthlyLimit) return null;
  return { apiKey, voiceId, timeoutMs, monthlyLimit };
}

async function readBoundedAudio(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.ok) throw new ElevenLabsStoryAudioError(response.status);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("audio/")) {
    throw new ElevenLabsStoryAudioError(response.status);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new ElevenLabsStoryAudioError(response.status);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new ElevenLabsStoryAudioError(response.status);
  }
  return bytes;
}

async function requestAudio(
  fetcher: typeof fetch,
  settings: ElevenLabsStoryAudioSettings,
  url: string,
  body: Record<string, unknown>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    return await readBoundedAudio(await fetcher(url, {
      method: "POST",
      headers: {
        "xi-api-key": settings.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }), maximumBytes);
  } catch (error) {
    if (error instanceof ElevenLabsStoryAudioError) throw error;
    throw new ElevenLabsStoryAudioError(null);
  } finally {
    clearTimeout(timeout);
  }
}

export class ElevenLabsStoryAudioClient {
  constructor(
    private readonly settings: ElevenLabsStoryAudioSettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async generateNarration(text: string): Promise<Uint8Array> {
    if (!text.trim() || text.length > 3_500) throw new ElevenLabsStoryAudioError(null);
    return requestAudio(
      this.fetcher,
      this.settings,
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.settings.voiceId)}?output_format=mp3_44100_128`,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.32,
          similarity_boost: 0.75,
          style: 0.65,
          speed: 0.92,
          use_speaker_boost: true,
        },
      },
      12_000_000,
    );
  }

  async generateInstrumental(lengthMs: number): Promise<Uint8Array> {
    const boundedLength = Math.min(180_000, Math.max(30_000, Math.ceil(lengthMs / 10_000) * 10_000));
    return requestAudio(
      this.fetcher,
      this.settings,
      "https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128",
      {
        prompt: "Instrumental cinematic background score for a heartfelt personal memory story: intimate felt piano, delicate acoustic guitar, warm strings, gentle nostalgic texture, slow emotional build to a hopeful resolve. Keep the arrangement soft and spacious so spoken narration remains clear. No vocals, no lyrics, no abrupt percussion.",
        music_length_ms: boundedLength,
        model_id: "music_v2_5",
        force_instrumental: true,
      },
      20_000_000,
    );
  }
}
