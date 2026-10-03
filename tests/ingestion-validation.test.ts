import assert from "node:assert/strict";
import test from "node:test";
import {
  FragmentInputError,
  inspectMediaBytes,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_DURATION_SECONDS,
  parseMp4DurationSeconds,
  validateTextFragment,
  validateUploadDescriptor,
} from "../src/lib/ingestion/fragment-validation";

const validDescriptor = {
  type: "image",
  contentType: "image/png",
  size: 24,
  capturedAt: "2026-09-04T12:04:00-04:00",
  capturedTimeZone: "America/New_York",
};

test("upload descriptors normalize safe defaults and timezone-aware timestamps", () => {
  const descriptor = validateUploadDescriptor(validDescriptor);
  assert.equal(descriptor.visibility, "private");
  assert.equal(descriptor.aiProcessingConsent, false);
  assert.equal(descriptor.capturedAt.toISOString(), "2026-09-04T16:04:00.000Z");
  assert.equal(descriptor.capturedTimeZone, "America/New_York");
});

test("upload descriptors reject unsupported types, oversize files, and missing offsets", () => {
  assert.throws(() => validateUploadDescriptor({ ...validDescriptor, type: "voice" }), FragmentInputError);
  assert.throws(() => validateUploadDescriptor({ ...validDescriptor, size: MAX_IMAGE_BYTES + 1 }), FragmentInputError);
  assert.throws(() => validateUploadDescriptor({ ...validDescriptor, capturedAt: "2026-09-04T12:04:00" }), FragmentInputError);
  assert.throws(() => validateUploadDescriptor({ ...validDescriptor, capturedTimeZone: "Not/AZone" }), FragmentInputError);
});

test("uploaded bytes must match the declared image content type", async () => {
  const pngHeader = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const inspected = await inspectMediaBytes(pngHeader, "image/png", "image");
  assert.match(inspected.checksumSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(inspectMediaBytes(Buffer.from("not an image"), "image/png", "image"), FragmentInputError);
});

test("MP4 duration parser reads version-zero and rejects videos over the cap", () => {
  const mvhd = Buffer.alloc(28);
  mvhd.writeUInt32BE(28, 0);
  mvhd.write("mvhd", 4, "ascii");
  mvhd.writeUInt32BE(1000, 20);
  mvhd.writeUInt32BE(60_000, 24);
  assert.equal(parseMp4DurationSeconds(mvhd), MAX_VIDEO_DURATION_SECONDS);
  mvhd.writeUInt32BE(60_001, 24);
  assert.ok((parseMp4DurationSeconds(mvhd) ?? 0) > MAX_VIDEO_DURATION_SECONDS);
});

test("text fragments enforce length and preserve timezone-aware capture time", () => {
  const fragment = validateTextFragment({
    textContent: "  A note from the event  ",
    capturedAt: validDescriptor.capturedAt,
    capturedTimeZone: validDescriptor.capturedTimeZone,
  });
  assert.equal(fragment.textContent, "A note from the event");
  assert.equal(fragment.visibility, "private");
  assert.equal(fragment.aiProcessingConsent, false);
  assert.throws(
    () => validateTextFragment({ textContent: " ".repeat(10001), capturedAt: validDescriptor.capturedAt, capturedTimeZone: "UTC" }),
    FragmentInputError,
  );
});
