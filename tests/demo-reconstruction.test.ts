import assert from "node:assert/strict";
import test from "node:test";
import {
  getDemoFragments,
  runDemoReconstruction,
  type DemoCandidate,
} from "../src/lib/pipeline/demo-reconstruction";
import { formatCaptureTime } from "../src/lib/domain/format-time";

const evidence = [
  { fragmentId: "demo-fragment-a", relationship: "temporal" },
  { fragmentId: "demo-fragment-b", relationship: "shared_location" },
  { fragmentId: "demo-fragment-c", relationship: "semantic_similarity" },
];

function createCandidate(fragmentId: string): DemoCandidate {
  const fragment = getDemoFragments().find((item) => item.id === fragmentId);
  assert.ok(fragment);
  return { ...fragment, retrievalScore: 2 };
}

test("demo reconstructs and persists a candidate from nearby fragments", async () => {
  let savedMomentId: string | undefined;
  let searchText: string | undefined;
  const result = await runDemoReconstruction({
    adapters: {
      async findCandidates(query) {
        searchText = query.searchText;
        return [createCandidate("demo-fragment-a"), createCandidate("demo-fragment-c")];
      },
      async saveMoment(moment) {
        savedMomentId = moment.id;
        return moment;
      },
    },
    reconstructor: {
      async generateStructured() {
        return {
          summary: "Three friends' cafeteria fragments appear to describe the same lunch rush.",
          confidence: 0.82,
          evidence,
        };
      },
    },
  });

  assert.equal(result.outcome, "candidate");
  if (result.outcome !== "candidate") assert.fail("expected a candidate moment");
  assert.equal(searchText, "cafeteria");
  assert.deepEqual(
    result.candidateFragments.map((fragment) => fragment.id),
    ["demo-fragment-a", "demo-fragment-b", "demo-fragment-c"],
  );
  assert.equal(result.moment.status, "candidate");
  assert.equal(result.moment.uncertaintyLabel, "likely");
  assert.match(result.moment.uncertaintyReason, /candidate until a group member confirms it/);
  assert.deepEqual(result.moment.evidence.map((item) => item.fragmentId), [
    "demo-fragment-a",
    "demo-fragment-b",
    "demo-fragment-c",
  ]);
  assert.equal(savedMomentId, result.moment.id);
});

test("demo rejects model evidence that was not in the retrieved candidate packet", async () => {
  await assert.rejects(
    runDemoReconstruction({
      adapters: {
        async findCandidates() {
          return [createCandidate("demo-fragment-a")];
        },
        async saveMoment(moment) {
          return moment;
        },
      },
      reconstructor: {
        async generateStructured() {
          return {
            summary: "A lunch event.",
            confidence: 0.9,
            evidence: [
              { fragmentId: "demo-fragment-b", relationship: "temporal" },
              { fragmentId: "invented-fragment", relationship: "shared_people" },
            ],
          };
        },
      },
    }),
    /outside the retrieved candidate set/,
  );
});

test("one member alone returns unknown and does not call Gemma or persist a moment", async () => {
  let modelCalled = false;
  let saved = false;
  const result = await runDemoReconstruction({
    adapters: {
      async findCandidates() {
        return [{ ...createCandidate("demo-fragment-a"), authorUserId: "arjun" }];
      },
      async saveMoment(moment) {
        saved = true;
        return moment;
      },
    },
    reconstructor: {
      async generateStructured() {
        modelCalled = true;
        return {};
      },
    },
  });

  assert.equal(result.outcome, "insufficient_evidence");
  if (result.outcome !== "insufficient_evidence") assert.fail("expected unknown evidence");
  assert.equal(result.uncertaintyLabel, "unknown");
  assert.match(result.uncertaintyReason, /only one member/);
  assert.equal(modelCalled, false);
  assert.equal(saved, false);
});

test("two temporal fragments from different members remain possible, not confirmed", async () => {
  const result = await runDemoReconstruction({
    adapters: {
      async findCandidates() {
        return [createCandidate("demo-fragment-a")];
      },
      async saveMoment(moment) {
        return moment;
      },
    },
    reconstructor: {
      async generateStructured() {
        return {
          summary: "Two cafeteria fragments may be related.",
          confidence: 0.99,
          evidence: [
            { fragmentId: "demo-fragment-a", relationship: "temporal" },
            { fragmentId: "demo-fragment-b", relationship: "temporal" },
          ],
        };
      },
    },
  });

  assert.equal(result.outcome, "candidate");
  if (result.outcome !== "candidate") assert.fail("expected a candidate moment");
  assert.equal(result.moment.uncertaintyLabel, "possible");
  assert.equal(result.moment.status, "candidate");
  assert.match(result.moment.uncertaintyReason, /not a confirmed moment/);
});

test("model cannot claim a shared-people relationship without participant evidence", async () => {
  await assert.rejects(
    runDemoReconstruction({
      adapters: {
        async findCandidates() {
          return [createCandidate("demo-fragment-a")];
        },
        async saveMoment(moment) {
          return moment;
        },
      },
      reconstructor: {
        async generateStructured() {
          return {
            summary: "The group was together.",
            confidence: 0.9,
            evidence: [
              { fragmentId: "demo-fragment-a", relationship: "shared_people" },
              { fragmentId: "demo-fragment-b", relationship: "shared_people" },
            ],
          };
        },
      },
    }),
    /unsupported shared_people evidence/,
  );
});

test("capture times use a stable UTC representation", () => {
  assert.equal(formatCaptureTime("2026-09-04T12:04:00.000Z"), "12:04Z");
});