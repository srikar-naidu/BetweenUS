import assert from "node:assert/strict";
import test from "node:test";
import { safeProcessingFailureCategory } from "../src/lib/processing/failure-category";

test("processing failure categories expose only approved diagnostics", () => {
  assert.equal(
    safeProcessingFailureCategory("gemma_runtime_unavailable"),
    "gemma_runtime_unavailable",
  );
  assert.equal(
    safeProcessingFailureCategory("raw provider error with private details"),
    "fragment_ingestion_failed",
  );
  assert.equal(safeProcessingFailureCategory(undefined), "fragment_ingestion_failed");
});
