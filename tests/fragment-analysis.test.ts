import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAGMENT_ANALYSIS_VERSION,
  fragmentAnalysisForMember,
  fragmentAnalysisResponseSchema,
  FragmentAnalysisValidationError,
  validateFragmentAnalysisOutput,
} from "../src/lib/ai/fragment-analysis";

const fragmentId = "fragment-a";
const sourceText = "We grabbed coffee and fries at the cafeteria after practice.";

const validOutput = {
  fragment_id: fragmentId,
  summary: "coffee and fries at the cafeteria",
  observed_facts: [
    {
      type: "place",
      value: "cafeteria",
      confidence: 0.98,
      evidence: {
        fragment_id: fragmentId,
        modality: "text",
        locator: null,
        evidence: "at the cafeteria",
      },
    },
    {
      type: "activity",
      value: "practice",
      confidence: 0.91,
      evidence: {
        fragment_id: fragmentId,
        modality: "text",
        locator: null,
        evidence: "after practice",
      },
    },
  ],
  people: [],
  entities: ["coffee", "fries", "cafeteria"],
  location_hint: "cafeteria",
  activity_hint: "practice",
  tone_hint: null,
  confidence: 0.9,
  uncertainty: { status: "possible", reason: "The note contains a place and activity reference." },
  evidence_fragment_ids: [fragmentId],
};

test("fragment analysis validates source quotes and preserves provenance fields", () => {
  const analysis = validateFragmentAnalysisOutput(validOutput, fragmentId, sourceText);
  assert.equal(analysis.analysisVersion, FRAGMENT_ANALYSIS_VERSION);
  assert.equal(analysis.fragmentId, fragmentId);
  assert.equal(analysis.uncertainty.status, "possible");
  assert.equal(analysis.observedFacts[0].evidence.evidence, "at the cafeteria");
  assert.deepEqual(analysis.evidenceFragmentIds, [fragmentId]);
});

test("member fragment analysis projection exposes observations but omits private internals", () => {
  const analysis = validateFragmentAnalysisOutput(validOutput, fragmentId, sourceText);
  const memberView = fragmentAnalysisForMember({
    ...analysis,
    id: "private-id",
    groupId: "private-group",
    authorUserId: "private-author",
    modelVersion: "gemma4:e2b",
    sourceContentSha256: "private-digest",
    analyzedAt: new Date("2026-10-04T12:00:00Z"),
  });

  assert.equal(memberView.summary, validOutput.summary);
  assert.equal(memberView.observedFacts[0].value, "cafeteria");
  assert.deepEqual(Object.keys(memberView).sort(), [
    "analyzedAt",
    "confidence",
    "observedFacts",
    "summary",
    "uncertainty",
  ]);
});

test("fragment analysis rejects invented IDs, unsupported source quotes, and certainty inflation", () => {
  assert.throws(
    () => validateFragmentAnalysisOutput({ ...validOutput, fragment_id: "other-fragment" }, fragmentId, sourceText),
    FragmentAnalysisValidationError,
  );
  assert.throws(
    () => validateFragmentAnalysisOutput({
      ...validOutput,
      observed_facts: [{
        ...validOutput.observed_facts[0],
        evidence: { ...validOutput.observed_facts[0].evidence, evidence: "at the airport" },
      }],
    }, fragmentId, sourceText),
    /not present in the source fragment/,
  );
  assert.throws(
    () => validateFragmentAnalysisOutput({
      ...validOutput,
      observed_facts: [{
        ...validOutput.observed_facts[0],
        evidence: { ...validOutput.observed_facts[0].evidence, evidence: "At the cafeteria" },
      }],
    }, fragmentId, sourceText),
    /not present in the source fragment/,
  );
  assert.throws(
    () => validateFragmentAnalysisOutput({
      ...validOutput,
      observed_facts: [{ ...validOutput.observed_facts[0], value: "airport" }],
    }, fragmentId, sourceText),
    /not present in the source fragment/,
  );
  assert.throws(
    () => validateFragmentAnalysisOutput({ ...validOutput, summary: "They ate lunch together." }, fragmentId, sourceText),
    /summary that is not present/,
  );
  assert.throws(
    () => validateFragmentAnalysisOutput({ ...validOutput, entities: ["airport"] }, fragmentId, sourceText),
    /not present in the source text/,
  );
  assert.throws(
    () => validateFragmentAnalysisOutput({
      ...validOutput,
      uncertainty: { status: "likely", reason: "Certain" },
    }, fragmentId, sourceText),
    /unsupported uncertainty status/,
  );
});

test("fragment uncertainty is derived from validated evidence, not the model's certainty label", () => {
  const analysis = validateFragmentAnalysisOutput({
    ...validOutput,
    uncertainty: { status: "unknown", reason: "The model's label disagrees with its evidence." },
  }, fragmentId, sourceText);

  assert.deepEqual(analysis.uncertainty, {
    status: "possible",
    reason: "The fragment contains directly cited observations, but their broader meaning remains uncertain.",
  });
});

test("fragment-analysis schema binds evidence to its source and disallows confirmed output", () => {
  const schema = fragmentAnalysisResponseSchema(fragmentId) as {
    properties: {
      fragment_id: { enum: string[] };
      uncertainty: { properties: { status: { enum: string[] } } };
    };
  };
  assert.deepEqual(schema.properties.fragment_id.enum, [fragmentId]);
  assert.deepEqual(schema.properties.uncertainty.properties.status.enum, ["possible", "unknown"]);
});

test("visual summary fields are derived from observations with valid fragment and image provenance", () => {
  const visualOutput = {
    ...validOutput,
    summary: "",
    observed_facts: [
      {
        type: "object",
        value: "wooden balcony",
        confidence: 0.99,
        evidence: {
          fragment_id: fragmentId,
          modality: "image",
          locator: "whole_image",
          evidence: "A wooden balcony is visible on the building.",
        },
      },
      {
        type: "place",
        value: "building",
        confidence: 0.5,
        evidence: {
          fragment_id: fragmentId,
          modality: "image",
          locator: "whole_image",
          evidence: "A wooden balcony is visible on the building.",
        },
      },
    ],
    people: ["Unsupported person"],
    entities: ["Unsupported entity"],
    location_hint: "Unsupported location",
    activity_hint: "Unsupported activity",
    tone_hint: "Unsupported tone",
    confidence: 0.99,
    evidence_fragment_ids: [fragmentId],
  };

  const analysis = validateFragmentAnalysisOutput(
    visualOutput,
    fragmentId,
    "",
    "image",
    ["whole_image"],
  );

  assert.equal(analysis.summary, "wooden balcony; building");
  assert.deepEqual(analysis.people, []);
  assert.deepEqual(analysis.entities, ["wooden balcony", "building"]);
  assert.equal(analysis.locationHint, "building");
  assert.equal(analysis.activityHint, null);
  assert.equal(analysis.toneHint, null);
  assert.equal(analysis.confidence, 0.5);
  const semanticallyDescribed = validateFragmentAnalysisOutput({
    ...visualOutput,
    observed_facts: [{
      ...visualOutput.observed_facts[0],
      value: "balcony",
      evidence: {
        ...visualOutput.observed_facts[0].evidence,
        evidence: "A railing runs across the upper level of the building.",
      },
    }],
  }, fragmentId, "", "image", ["whole_image"]);
  assert.equal(semanticallyDescribed.observedFacts[0].value, "balcony");
  assert.throws(
    () => validateFragmentAnalysisOutput({
      ...visualOutput,
      observed_facts: [{
        ...visualOutput.observed_facts[0],
        evidence: {
          ...visualOutput.observed_facts[0].evidence,
          locator: "different_image",
        },
      }],
    }, fragmentId, "", "image", ["whole_image"]),
    /ungrounded visual observation/,
  );
});
