import assert from "node:assert/strict";
import test from "node:test";
import type { TemporalFragmentCandidate } from "../src/lib/domain/memory";
import { MAX_CONTEXT_CANDIDATES, rankFragmentCandidates } from "../src/lib/retrieval/ranking";

function candidate(input: Partial<TemporalFragmentCandidate> & Pick<TemporalFragmentCandidate, "fragmentId" | "capturedAt" | "semanticSummary" | "entityKeys">): TemporalFragmentCandidate {
  return {
    momentIds: [],
    retrievalScore: 0,
    matchedSignals: [],
    ...input,
  };
}

test("hybrid ranking recovers paraphrased entity matches over a near-time lexical distractor", () => {
  const query = {
    groupId: "group-a",
    startAt: new Date("2026-09-04T12:00:00Z"),
    endAt: new Date("2026-09-04T12:30:00Z"),
    searchText: "cafeteria coffee fries",
    entityKeys: ["cafeteria", "coffee", "fries"],
    knownMomentIds: ["moment-lunch"],
    limit: 10,
  };
  const candidates = [
    candidate({
      fragmentId: "lexical-distractor",
      capturedAt: new Date("2026-09-04T12:15:00Z"),
      semanticSummary: "Cafeteria coffee fries special menu",
      entityKeys: ["menu"],
    }),
    candidate({
      fragmentId: "same-event",
      capturedAt: new Date("2026-09-04T12:23:00Z"),
      semanticSummary: "The crew met by the serving line after practice",
      entityKeys: ["cafeteria", "coffee", "fries"],
      momentIds: ["moment-lunch"],
    }),
  ];
  const midpoint = new Date("2026-09-04T12:15:00Z").getTime();
  const baseline = [...candidates].sort((left, right) => {
    const score = (item: TemporalFragmentCandidate) => {
      const lexicalMatches = query.searchText.split(" ").filter((term) =>
        item.semanticSummary.toLowerCase().includes(term),
      ).length;
      return lexicalMatches * 10 - Math.abs(item.capturedAt.getTime() - midpoint) / 60_000;
    };
    return score(right) - score(left);
  });

  const ranked = rankFragmentCandidates(query, candidates);
  assert.equal(baseline[0].fragmentId, "lexical-distractor");
  assert.equal(ranked[0].fragmentId, "same-event");
  assert.ok(ranked[0].retrievalScore > ranked[1].retrievalScore);
  assert.deepEqual(ranked[0].matchedSignals, ["temporal", "entity_overlap", "known_moment"]);
});

test("candidate ranking has a deterministic top-N cap", () => {
  const query = {
    groupId: "group-a",
    startAt: new Date("2026-09-04T12:00:00Z"),
    endAt: new Date("2026-09-04T13:00:00Z"),
    limit: 100,
  };
  const ranked = rankFragmentCandidates(query, Array.from({ length: 25 }, (_, index) =>
    candidate({
      fragmentId: `fragment-${index}`,
      capturedAt: new Date(`2026-09-04T12:${String(index).padStart(2, "0")}:00Z`),
      semanticSummary: "",
      entityKeys: [],
    }),
  ));
  assert.equal(MAX_CONTEXT_CANDIDATES, 12);
  assert.equal(ranked.length, MAX_CONTEXT_CANDIDATES);
});
