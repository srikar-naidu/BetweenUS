import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutomaticallyAnalyzeGroupPost } from "../src/lib/processing/automatic-group-analysis";

test("only group-visible posts are automatically analyzed", () => {
  assert.equal(shouldAutomaticallyAnalyzeGroupPost("group"), true);
  assert.equal(shouldAutomaticallyAnalyzeGroupPost("private"), false);
  assert.equal(shouldAutomaticallyAnalyzeGroupPost("restricted"), false);
});
