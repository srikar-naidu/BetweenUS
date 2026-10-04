import assert from "node:assert/strict";
import test from "node:test";
import {
  FragmentInputError,
  validateTextFragment,
} from "../src/lib/ingestion/fragment-validation";

test("text fragments enforce length and preserve timezone-aware capture time", () => {
  const fragment = validateTextFragment({
    textContent: "  A note from the event  ",
    capturedAt: "2026-09-04T12:04:00-04:00",
    capturedTimeZone: "America/New_York",
  });
  assert.equal(fragment.textContent, "A note from the event");
  assert.equal(fragment.visibility, "private");
  assert.equal(fragment.aiProcessingConsent, false);
  assert.throws(
    () => validateTextFragment({
      textContent: " ".repeat(10001),
      capturedAt: "2026-09-04T12:04:00-04:00",
      capturedTimeZone: "America/New_York",
    }),
    FragmentInputError,
  );
  assert.throws(
    () => validateTextFragment({
      textContent: "A note",
      capturedAt: "2026-09-04T12:04:00",
      capturedTimeZone: "America/New_York",
    }),
    FragmentInputError,
  );
  assert.throws(
    () => validateTextFragment({
      textContent: "A note",
      capturedAt: "2026-09-04T12:04:00-04:00",
      capturedTimeZone: "Not/AZone",
    }),
    FragmentInputError,
  );
});
