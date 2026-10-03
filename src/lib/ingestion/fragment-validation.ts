import { createHash } from "node:crypto";
import { fileTypeFromBuffer } from "file-type";
import type { FragmentType, FragmentVisibility } from "@/lib/domain/memory";

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_DURATION_SECONDS = 60;
export const MAX_TEXT_CHARACTERS = 10_000;

const supportedMimeTypes: Record<"image" | "screenshot" | "video", readonly string[]> = {
  image: ["image/jpeg", "image/png", "image/webp"],
  screenshot: ["image/jpeg", "image/png", "image/webp"],
  video: ["video/mp4"],
};

export class FragmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FragmentInputError";
  }
}

export interface ValidatedUploadDescriptor {
  type: "image" | "screenshot" | "video";
  contentType: string;
  size: number;
  capturedAt: Date;
  capturedTimeZone: string;
  visibility: FragmentVisibility;
  aiProcessingConsent: boolean;
  caption: string | null;
}

export function validateUploadDescriptor(input: unknown): ValidatedUploadDescriptor {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new FragmentInputError("Invalid upload details");
  }
  const value = input as Record<string, unknown>;
  if (value.type !== "image" && value.type !== "screenshot" && value.type !== "video") {
    throw new FragmentInputError("Unsupported fragment type");
  }
  if (typeof value.contentType !== "string") {
    throw new FragmentInputError("A content type is required");
  }
  const contentType = value.contentType.split(";", 1)[0].trim().toLowerCase();
  if (!supportedMimeTypes[value.type].includes(contentType)) {
    throw new FragmentInputError("Unsupported content type for this fragment");
  }
  if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0) {
    throw new FragmentInputError("File size must be a positive integer");
  }
  const maxSize = value.type === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if ((value.size as number) > maxSize) {
    throw new FragmentInputError("File exceeds the size limit");
  }
  if (typeof value.capturedAt !== "string" || !/(Z|[+-]\d{2}:\d{2})$/i.test(value.capturedAt)) {
    throw new FragmentInputError("Capture time must include a timezone offset");
  }
  const capturedAt = new Date(value.capturedAt);
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new FragmentInputError("Capture time is invalid");
  }
  if (typeof value.capturedTimeZone !== "string" || value.capturedTimeZone.length > 80) {
    throw new FragmentInputError("A valid capture timezone is required");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.capturedTimeZone }).format(capturedAt);
  } catch {
    throw new FragmentInputError("Capture timezone is invalid");
  }
  const visibility = value.visibility ?? "private";
  if (visibility !== "private" && visibility !== "group" && visibility !== "restricted") {
    throw new FragmentInputError("Invalid fragment visibility");
  }
  const aiProcessingConsent = value.aiProcessingConsent ?? false;
  if (typeof aiProcessingConsent !== "boolean") {
    throw new FragmentInputError("AI processing consent must be explicit");
  }
  if (value.caption !== undefined && value.caption !== null &&
      (typeof value.caption !== "string" || value.caption.length > 1000)) {
    throw new FragmentInputError("Caption must be at most 1,000 characters");
  }
  return {
    type: value.type,
    contentType,
    size: value.size as number,
    capturedAt,
    capturedTimeZone: value.capturedTimeZone,
    visibility,
    aiProcessingConsent,
    caption: typeof value.caption === "string" ? value.caption.trim() || null : null,
  };
}

export function parseMp4DurationSeconds(buffer: Buffer): number | null {
  for (let typeOffset = buffer.indexOf("mvhd"); typeOffset >= 0; typeOffset = buffer.indexOf("mvhd", typeOffset + 4)) {
    if (typeOffset < 4 || typeOffset + 24 > buffer.length) continue;
    const boxStart = typeOffset - 4;
    const boxSize = buffer.readUInt32BE(boxStart);
    if (boxSize < 28 || boxStart + boxSize > buffer.length) continue;
    const version = buffer[typeOffset + 4];
    let timescale: number;
    let duration: number;
    if (version === 0 && boxSize >= 28) {
      timescale = buffer.readUInt32BE(typeOffset + 16);
      duration = buffer.readUInt32BE(typeOffset + 20);
    } else if (version === 1 && boxSize >= 40) {
      timescale = buffer.readUInt32BE(typeOffset + 24);
      const duration64 = buffer.readBigUInt64BE(typeOffset + 28);
      if (duration64 > BigInt(Number.MAX_SAFE_INTEGER)) continue;
      duration = Number(duration64);
    } else {
      continue;
    }
    if (timescale === 0) continue;
    const seconds = duration / timescale;
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return null;
}

export async function inspectMediaBytes(
  buffer: Buffer,
  declaredContentType: string,
  type: Extract<FragmentType, "image" | "screenshot" | "video">,
): Promise<{ contentType: string; checksumSha256: string; durationSeconds?: number }> {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || detected.mime !== declaredContentType || !supportedMimeTypes[type].includes(detected.mime)) {
    throw new FragmentInputError("Uploaded bytes do not match the declared content type");
  }
  let durationSeconds: number | undefined;
  if (type === "video") {
    const parsedDuration = parseMp4DurationSeconds(buffer);
    if (parsedDuration === null || parsedDuration > MAX_VIDEO_DURATION_SECONDS) {
      throw new FragmentInputError("Video must have a readable duration of 60 seconds or less");
    }
    durationSeconds = parsedDuration;
  }
  return {
    contentType: detected.mime,
    checksumSha256: createHash("sha256").update(buffer).digest("hex"),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

export function validateTextFragment(input: unknown): {
  textContent: string;
  capturedAt: Date;
  capturedTimeZone: string;
  visibility: FragmentVisibility;
  aiProcessingConsent: boolean;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new FragmentInputError("Invalid text fragment");
  }
  const value = input as Record<string, unknown>;
  if (typeof value.textContent !== "string" || !value.textContent.trim() || value.textContent.length > MAX_TEXT_CHARACTERS) {
    throw new FragmentInputError("Text must contain 1 to 10,000 characters");
  }
  const common = validateUploadDescriptor({
    type: "image",
    contentType: "image/png",
    size: 1,
    capturedAt: value.capturedAt,
    capturedTimeZone: value.capturedTimeZone,
    visibility: value.visibility,
    aiProcessingConsent: value.aiProcessingConsent,
  });
  return {
    textContent: value.textContent.trim(),
    capturedAt: common.capturedAt,
    capturedTimeZone: common.capturedTimeZone,
    visibility: common.visibility,
    aiProcessingConsent: common.aiProcessingConsent,
  };
}
