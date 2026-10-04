import { MAX_VOICE_TRANSCRIPT_CHARACTERS } from "@/lib/ingestion/voice-validation";

export interface ElevenLabsTranscriptionSettings {
  apiKey: string;
  timeoutMs: number;
  monthlySeconds: number;
  monthlyRequests: number;
}

export interface VoiceWord {
  text: string;
  start: number;
  end: number;
  speakerId: string | null;
}

export interface VoiceTranscriptResult {
  text: string;
  languageCode: string | null;
  words: VoiceWord[];
}

export class ElevenLabsConfigurationError extends Error {
  constructor() {
    super("ElevenLabs transcription is not enabled");
    this.name = "ElevenLabsConfigurationError";
  }
}

export class ElevenLabsApiError extends Error {
  constructor(public readonly statusCode: number | null) {
    super("ElevenLabs transcription request failed");
    this.name = "ElevenLabsApiError";
  }
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function positiveInteger(value: string | undefined, maximum: number): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : 0;
}

export function getElevenLabsTranscriptionSettings(
  environment: RuntimeEnvironment = process.env,
): ElevenLabsTranscriptionSettings | null {
  if (environment.ELEVENLABS_TRANSCRIPTION_ENABLED !== "true") return null;
  const apiKey = environment.ELEVENLABS_API_KEY?.trim();
  const monthlySeconds = positiveInteger(environment.ELEVENLABS_MONTHLY_SECONDS, 3600);
  const monthlyRequests = positiveInteger(environment.ELEVENLABS_MONTHLY_REQUESTS, 60);
  const timeoutMs = Number(environment.ELEVENLABS_TIMEOUT_MS ?? "60000");
  if (
    !apiKey ||
    !monthlySeconds ||
    !monthlyRequests ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 120000
  ) {
    return null;
  }
  return { apiKey, timeoutMs, monthlySeconds, monthlyRequests };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseVoiceTranscript(value: unknown): VoiceTranscriptResult {
  const result = object(value);
  if (
    !result ||
    typeof result.text !== "string" ||
    !result.text.trim() ||
    result.text.length > MAX_VOICE_TRANSCRIPT_CHARACTERS
  ) {
    throw new ElevenLabsApiError(null);
  }
  const words = Array.isArray(result.words) ? result.words : [];
  if (words.length > 5000) throw new ElevenLabsApiError(null);
  const parsedWords = words.flatMap((entry): VoiceWord[] => {
    const word = object(entry);
    if (
      !word ||
      typeof word.text !== "string" ||
      typeof word.start !== "number" ||
      !Number.isFinite(word.start) ||
      typeof word.end !== "number" ||
      !Number.isFinite(word.end) ||
      word.start < 0 ||
      word.end < word.start
    ) return [];
    return [{
      text: word.text.slice(0, 120),
      start: word.start,
      end: word.end,
      speakerId: typeof word.speaker_id === "string" ? word.speaker_id.slice(0, 64) : null,
    }];
  });
  if (parsedWords.length !== words.length) throw new ElevenLabsApiError(null);
  return {
    text: result.text.trim(),
    languageCode: typeof result.language_code === "string" ? result.language_code.slice(0, 16) : null,
    words: parsedWords,
  };
}

export class ElevenLabsClient {
  constructor(
    private readonly settings: ElevenLabsTranscriptionSettings,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async transcribe(input: { bytes: Uint8Array; fileName?: string }): Promise<VoiceTranscriptResult> {
    const form = new FormData();
    form.append("model_id", "scribe_v2");
    form.append("timestamps_granularity", "word");
    form.append("diarize", "false");
    form.append("tag_audio_events", "false");
    const fileBuffer = new ArrayBuffer(input.bytes.byteLength);
    new Uint8Array(fileBuffer).set(input.bytes);
    form.append("file", new Blob([fileBuffer], { type: "audio/wav" }), input.fileName ?? "voice-note.wav");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const response = await this.fetcher("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": this.settings.apiKey },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) throw new ElevenLabsApiError(response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ElevenLabsApiError(response.status);
      }
      return parseVoiceTranscript(body);
    } catch (error) {
      if (error instanceof ElevenLabsApiError) throw error;
      throw new ElevenLabsApiError(null);
    } finally {
      clearTimeout(timer);
    }
  }
}
