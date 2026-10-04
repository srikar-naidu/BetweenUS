import assert from "node:assert/strict";
import test from "node:test";
import { FragmentInputError } from "../src/lib/ingestion/fragment-validation";
import {
  MAX_IMAGE_FILE_BYTES,
  MAX_MEDIA_CAPTION_CHARACTERS,
  MAX_VIDEO_FILE_BYTES,
  validateGroupMedia,
  validateMediaCaption,
} from "../src/lib/ingestion/media-validation";

function bytesWithSignature(signature: number[], length = Math.max(signature.length, 12)) {
  const bytes = new Uint8Array(length);
  bytes.set(signature);
  return bytes;
}

test("group media validation accepts supported image and video signatures", () => {
  const validSamples = [
    { mimeType: "image/jpeg", bytes: bytesWithSignature([0xff, 0xd8, 0xff]), type: "image", extension: "jpg" },
    { mimeType: "image/png", bytes: bytesWithSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), type: "image", extension: "png" },
    { mimeType: "image/webp", bytes: bytesWithSignature([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), type: "image", extension: "webp" },
    { mimeType: "video/mp4", bytes: bytesWithSignature([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]), type: "video", extension: "mp4" },
    { mimeType: "video/webm", bytes: bytesWithSignature([0x1a, 0x45, 0xdf, 0xa3]), type: "video", extension: "webm" },
  ] as const;

  for (const sample of validSamples) {
    const result = validateGroupMedia(sample.bytes, sample.mimeType);
    assert.equal(result.type, sample.type);
    assert.equal(result.extension, sample.extension);
    assert.equal(result.mimeType, sample.mimeType);
  }
});

test("group media validation rejects unsupported MIME types and mismatched signatures", () => {
  assert.throws(
    () => validateGroupMedia(bytesWithSignature([0xff, 0xd8, 0xff]), "image/svg+xml"),
    FragmentInputError,
  );
  assert.throws(
    () => validateGroupMedia(bytesWithSignature([0x89, 0x50, 0x4e, 0x47]), "image/jpeg"),
    FragmentInputError,
  );
  assert.throws(() => validateGroupMedia(new Uint8Array(), "video/mp4"), FragmentInputError);
});

test("group media validation enforces exact photo and video byte limits", () => {
  assert.equal(
    validateGroupMedia(bytesWithSignature([0xff, 0xd8, 0xff], MAX_IMAGE_FILE_BYTES), "image/jpeg").fileSizeBytes,
    MAX_IMAGE_FILE_BYTES,
  );
  assert.equal(
    validateGroupMedia(bytesWithSignature([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70], MAX_VIDEO_FILE_BYTES), "video/mp4").fileSizeBytes,
    MAX_VIDEO_FILE_BYTES,
  );
  assert.throws(
    () => validateGroupMedia(bytesWithSignature([0xff, 0xd8, 0xff], MAX_IMAGE_FILE_BYTES + 1), "image/jpeg"),
    FragmentInputError,
  );
  assert.throws(
    () => validateGroupMedia(bytesWithSignature([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70], MAX_VIDEO_FILE_BYTES + 1), "video/mp4"),
    FragmentInputError,
  );
});

test("media captions are trimmed and bounded", () => {
  const maximumCaption = "a".repeat(MAX_MEDIA_CAPTION_CHARACTERS);
  assert.equal(validateMediaCaption(`  ${maximumCaption}  `), maximumCaption);
  assert.equal(validateMediaCaption("   "), null);
  assert.throws(
    () => validateMediaCaption(`${maximumCaption}a`),
    FragmentInputError,
  );
});
