import type { FragmentType } from "@/lib/domain/memory";
import { FragmentInputError } from "@/lib/ingestion/fragment-validation";

export const MAX_IMAGE_FILE_BYTES = 12_000_000;
export const MAX_VIDEO_FILE_BYTES = 25_000_000;
export const MAX_MEDIA_CAPTION_CHARACTERS = 1_000;

type GroupMediaMimeType = ValidatedGroupMedia["mimeType"];

const mediaTypes = {
  "image/jpeg": { type: "image", extension: "jpg", maximumBytes: MAX_IMAGE_FILE_BYTES },
  "image/png": { type: "image", extension: "png", maximumBytes: MAX_IMAGE_FILE_BYTES },
  "image/webp": { type: "image", extension: "webp", maximumBytes: MAX_IMAGE_FILE_BYTES },
  "video/mp4": { type: "video", extension: "mp4", maximumBytes: MAX_VIDEO_FILE_BYTES },
  "video/webm": { type: "video", extension: "webm", maximumBytes: MAX_VIDEO_FILE_BYTES },
} as const satisfies Record<
  GroupMediaMimeType,
  { type: "image" | "video"; extension: ValidatedGroupMedia["extension"]; maximumBytes: number }
>;

function isGroupMediaMimeType(value: string): value is GroupMediaMimeType {
  return Object.hasOwn(mediaTypes, value);
}

export interface ValidatedGroupMedia {
  type: Extract<FragmentType, "image" | "video">;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "video/mp4" | "video/webm";
  extension: "jpg" | "png" | "webp" | "mp4" | "webm";
  fileSizeBytes: number;
  maximumBytes: number;
}

export function validateGroupMedia(
  bytes: Uint8Array,
  declaredMimeType: string,
): ValidatedGroupMedia {
  const mimeType = declaredMimeType.toLowerCase().split(";")[0].trim();
  if (!isGroupMediaMimeType(mimeType)) {
    throw new FragmentInputError("Choose a JPEG, PNG, or WebP photo, or an MP4 or WebM video");
  }
  const mediaType = mediaTypes[mimeType];
  const maximumBytes = mediaType.maximumBytes;
  if (!bytes.byteLength || bytes.byteLength > maximumBytes) {
    throw new FragmentInputError(mediaType.type === "image"
      ? "Photos must be smaller than 12 MB"
      : "Videos must be smaller than 25 MB");
  }

  const startsWith = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  let validSignature = false;
  switch (mimeType) {
    case "image/jpeg":
      validSignature = startsWith(0xff, 0xd8, 0xff);
      break;
    case "image/png":
      validSignature = startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
      break;
    case "image/webp":
      validSignature =
        bytes.byteLength >= 12 &&
        startsWith(0x52, 0x49, 0x46, 0x46) &&
        String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
      break;
    case "video/mp4":
      validSignature =
        bytes.byteLength >= 12 &&
        String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp";
      break;
    case "video/webm":
      validSignature = startsWith(0x1a, 0x45, 0xdf, 0xa3);
      break;
  }
  if (!validSignature) {
    throw new FragmentInputError("The selected file does not match its declared photo or video type");
  }
  return {
    type: mediaType.type,
    mimeType,
    extension: mediaType.extension,
    fileSizeBytes: bytes.byteLength,
    maximumBytes,
  };
}

export type ValidatedAlbumCover = Omit<ValidatedGroupMedia, "type"> & { type: "image" };

export function validateAlbumCover(
  bytes: Uint8Array,
  declaredMimeType: string,
): ValidatedAlbumCover {
  const media = validateGroupMedia(bytes, declaredMimeType);
  if (media.type !== "image") {
    throw new FragmentInputError("Album covers must be JPEG, PNG, or WebP images");
  }
  return { ...media, type: "image" };
}

export function validateMediaCaption(value: string): string | null {
  const caption = value.trim();
  if (caption.length > MAX_MEDIA_CAPTION_CHARACTERS) {
    throw new FragmentInputError("Captions must be 1,000 characters or fewer");
  }
  return caption || null;
}
