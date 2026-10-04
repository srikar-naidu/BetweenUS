import assert from "node:assert/strict";
import test from "node:test";
import type { ContextPacketFragment, FragmentContextPacket } from "../src/lib/pipeline/context-packet";
import {
  deriveMomentUncertainty,
  momentReconstructionResponseSchema,
  validateMomentReconstructionOutput,
} from "../src/lib/pipeline/moment-reconstruction";

function contextFragment(input: {
  id: string;
  author: string;
  minutes: number;
  facts?: ContextPacketFragment["facts"];
  entities?: string[];
  summary?: string;
}): ContextPacketFragment {
  return {
    fragment_id: input.id,
    author_key: input.author,
    captured_at: new Date(Date.parse("2026-10-04T12:00:00Z") + input.minutes * 60_000).toISOString(),
    summary: input.summary ?? "coffee at the cafeteria",
    entities: input.entities ?? ["cafeteria", "coffee"],
    facts: input.facts ?? [{ type: "place", value: "cafeteria", evidence: "at the cafeteria" }],
    retrieval_score: 10,
    matched_signals: ["temporal", "entity_overlap"],
  };
}

function packet(fragments: ContextPacketFragment[]): FragmentContextPacket {
  return {
    version: "context-packet-v1",
    group_id: "group-a",
    anchor_fragment_id: fragments[0].fragment_id,
    time_window: {
      start: "2026-10-04T11:40:00.000Z",
      end: "2026-10-04T12:40:00.000Z",
    },
    candidate_fragments: fragments,
  };
}

const validOutput = {
  title: "Lunch at the cafeteria",
  summary: "Several members mention coffee at the cafeteria.",
  confidence: 0.99,
  evidence: [
    { fragment_id: "fragment-a", relationship: "shared_location" },
    { fragment_id: "fragment-b", relationship: "shared_location" },
  ],
  contradictions: [{
    summary: "The reported time differs.",
    evidence: [
      { fragment_id: "fragment-a", quote: "at the cafeteria" },
      { fragment_id: "fragment-b", quote: "at the cafeteria" },
    ],
  }],
  missing_evidence: ["A direct confirmation of who was present."],
  uncertainty_notes: ["The same location does not prove the members were together."],
  inference_notes: ["The entries are close in time."],
};

test("moment reconstruction validates candidate evidence against authorized observations", () => {
  const authorizedPacket = packet([
    contextFragment({ id: "fragment-a", author: "author-a", minutes: 0 }),
    contextFragment({ id: "fragment-b", author: "author-b", minutes: 5 }),
  ]);
  const proposal = validateMomentReconstructionOutput(validOutput, authorizedPacket);

  assert.equal(proposal.summary, validOutput.summary);
  assert.deepEqual(proposal.evidence.map((item) => item.fragmentId), ["fragment-a", "fragment-b"]);
  assert.deepEqual(
    proposal.contradictions[0].evidence.map((item) => item.fragmentId),
    ["fragment-a", "fragment-b"],
  );
  const schema = momentReconstructionResponseSchema(authorizedPacket) as {
    properties: { evidence: { items: { properties: { fragment_id: { enum: string[] } } } } };
  };
  assert.deepEqual(schema.properties.evidence.items.properties.fragment_id.enum, [
    "fragment-a",
    "fragment-b",
  ]);
});

test("moment reconstruction rejects invented IDs and unsupported relationship claims", () => {
  const authorizedPacket = packet([
    contextFragment({ id: "fragment-a", author: "author-a", minutes: 0 }),
    contextFragment({
      id: "fragment-b",
      author: "author-b",
      minutes: 5,
      facts: [{ type: "activity", value: "practice", evidence: "after practice" }],
      entities: ["practice"],
    }),
  ]);
  assert.throws(
    () => validateMomentReconstructionOutput({
      ...validOutput,
      evidence: [
        { fragment_id: "fragment-a", relationship: "temporal" },
        { fragment_id: "invented-fragment", relationship: "temporal" },
      ],
    }, authorizedPacket),
    /outside the authorized context packet/,
  );
  assert.throws(
    () => validateMomentReconstructionOutput({
      ...validOutput,
      evidence: [
        { fragment_id: "fragment-a", relationship: "shared_people" },
        { fragment_id: "fragment-b", relationship: "shared_people" },
      ],
    }, authorizedPacket),
    /unsupported shared_people evidence/,
  );
  assert.throws(
    () => validateMomentReconstructionOutput({
      ...validOutput,
      evidence: [
        { fragment_id: "fragment-a", relationship: "temporal" },
        { fragment_id: "fragment-b", relationship: "temporal" },
      ],
      contradictions: [{
        summary: "Invented source",
        evidence: [
          { fragment_id: "fragment-a", quote: "at the cafeteria" },
          { fragment_id: "unknown", quote: "at the cafeteria" },
        ],
      }],
    }, authorizedPacket),
    /outside the context packet/,
  );
});

test("uncertainty is deterministic and only independent corroborated evidence can become likely", () => {
  const twoMembers = packet([
    contextFragment({ id: "fragment-a", author: "author-a", minutes: 0 }),
    contextFragment({ id: "fragment-b", author: "author-b", minutes: 5 }),
  ]).candidate_fragments;
  const twoMemberEvidence = [
    { fragmentId: "fragment-a", relationship: "shared_location" as const },
    { fragmentId: "fragment-b", relationship: "shared_location" as const },
  ];
  assert.equal(deriveMomentUncertainty(twoMembers, twoMemberEvidence).label, "possible");

  const threeMembers = packet([
    contextFragment({ id: "fragment-a", author: "author-a", minutes: 0 }),
    contextFragment({ id: "fragment-b", author: "author-b", minutes: 5 }),
    contextFragment({ id: "fragment-c", author: "author-c", minutes: 10 }),
  ]).candidate_fragments;
  const threeMemberEvidence = threeMembers.map((fragment) => ({
    fragmentId: fragment.fragment_id,
    relationship: "shared_location" as const,
  }));
  assert.equal(deriveMomentUncertainty(threeMembers, threeMemberEvidence).label, "likely");
  assert.equal(
    deriveMomentUncertainty(threeMembers, threeMemberEvidence).outcome,
    "candidate",
  );

  const oneAuthor = twoMembers.map((fragment) => ({ ...fragment, author_key: "same-author" }));
  assert.equal(deriveMomentUncertainty(oneAuthor, twoMemberEvidence).label, "unknown");
  assert.equal(deriveMomentUncertainty(oneAuthor, twoMemberEvidence).outcome, "insufficient_evidence");
});
