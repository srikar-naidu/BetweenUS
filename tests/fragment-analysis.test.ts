import assert from "node:assert/strict";
import test from "node:test";
import {
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
  assert.equal(analysis.analysisVersion, "fragment-analysis-v1");
  assert.equal(analysis.fragmentId, fragmentId);
  assert.equal(analysis.uncertainty.status, "possible");
  assert.equal(analysis.observedFacts[0].evidence, "at the cafeteria");
  assert.deepEqual(analysis.evidenceFragmentIds, [fragmentId]);
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
    /not supported by its evidence/,
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
    /uncertainty status inconsistent/,
  );
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
