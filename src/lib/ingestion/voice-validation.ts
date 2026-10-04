import type { FragmentVisibility } from "@/lib/domain/memory";
import { FragmentInputError } from "@/lib/ingestion/fragment-validation";

export const MAX_VOICE_CLIP_SECONDS = 60;
export const MAX_VOICE_FILE_BYTES = 2_000_000;
export const MAX_VOICE_TRANSCRIPT_CHARACTERS = 10_000;

export interface ValidatedVoiceClip {
  durationSeconds: number;
  fileSizeBytes: number;
  mimeType: "audio/wav";
}

export function validateVoiceClip(
  bytes: Uint8Array,
  declaredMimeType: string,
): ValidatedVoiceClip {
  if (
    declaredMimeType !== "audio/wav" &&
    declaredMimeType !== "audio/x-wav" &&
    declaredMimeType !== "application/octet-stream"
  ) {
    throw new FragmentInputError("Voice notes must be uploaded as WAV audio");
  }
  if (bytes.byteLength < 44 || bytes.byteLength > MAX_VOICE_FILE_BYTES) {
    throw new FragmentInputError("Voice notes must be between 44 bytes and 2 MB");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (
    ascii(0, 4) !== "RIFF" ||
    view.getUint32(4, true) !== bytes.byteLength - 8 ||
    ascii(8, 4) !== "WAVE"
  ) {
    throw new FragmentInputError("Voice note is not a valid WAV file");
  }

  let format: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const chunkId = ascii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const contentOffset = offset + 8;
    if (chunkSize > bytes.byteLength - contentOffset) {
      throw new FragmentInputError("Voice note contains an invalid WAV chunk");
    }
    if (chunkId === "fmt ") {
      if (chunkSize < 16) throw new FragmentInputError("Voice note has invalid WAV audio settings");
      format = view.getUint16(contentOffset, true);
      channels = view.getUint16(contentOffset + 2, true);
      sampleRate = view.getUint32(contentOffset + 4, true);
      byteRate = view.getUint32(contentOffset + 8, true);
      bitsPerSample = view.getUint16(contentOffset + 14, true);
    } else if (chunkId === "data") {
      dataBytes = chunkSize;
    }
    offset = contentOffset + chunkSize + (chunkSize % 2);
  }
  if (
    format !== 1 ||
    channels !== 1 ||
    sampleRate !== 16_000 ||
    bitsPerSample !== 16 ||
    byteRate !== 32_000 ||
    dataBytes === null ||
    dataBytes % 2 !== 0
  ) {
    throw new FragmentInputError("Voice notes must be mono 16-bit PCM WAV at 16 kHz");
  }
  const durationSeconds = dataBytes / byteRate;
  if (durationSeconds < 0.1 || durationSeconds > MAX_VOICE_CLIP_SECONDS) {
    throw new FragmentInputError("Voice notes must be between 0.1 and 60 seconds");
  }
  return {
    durationSeconds,
    fileSizeBytes: bytes.byteLength,
    mimeType: "audio/wav",
  };
}

export function validateVoiceCaptureMetadata(input: {
  capturedAt: string;
  capturedTimeZone: string;
}): { capturedAt: Date; capturedTimeZone: string } {
  if (!input.capturedAt || input.capturedAt.length > 64) {
    throw new FragmentInputError("Capture time is invalid");
  }
  if (!input.capturedTimeZone || input.capturedTimeZone.length > 80) {
    throw new FragmentInputError("A valid capture timezone is required");
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(input.capturedAt)) {
    throw new FragmentInputError("Capture time must include a timezone offset");
  }
  const capturedAt = new Date(input.capturedAt);
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new FragmentInputError("Capture time is invalid");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.capturedTimeZone }).format(capturedAt);
  } catch {
    throw new FragmentInputError("Capture timezone is invalid");
  }
  return { capturedAt, capturedTimeZone: input.capturedTimeZone };
}

export function isFragmentVisibility(value: unknown): value is FragmentVisibility {
  return value === "private" || value === "group" || value === "restricted";
}
