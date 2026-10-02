import assert from "node:assert/strict";
import test from "node:test";
import {
  getDemoFragments,
  runDemoReconstruction,
  type DemoCandidate,
} from "../src/lib/pipeline/demo-reconstruction";

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

  assert.equal(searchText, "cafeteria");
  assert.deepEqual(
    result.candidateFragments.map((fragment) => fragment.id),
    ["demo-fragment-a", "demo-fragment-b", "demo-fragment-c"],
  );
  assert.equal(result.moment.status, "candidate");
  assert.equal(result.moment.uncertaintyLabel, "likely");
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