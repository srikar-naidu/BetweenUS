import assert from "node:assert/strict";
import test from "node:test";
import {
  createGemmaService,
  type StructuredGenerationInput,
} from "../src/lib/ai/gemma-provider";
import {
  generateFragmentAnalysis,
  generateOrReuseFragmentAnalysis,
  type FragmentAnalysisGenerator,
} from "../src/lib/ai/fragment-analysis";
import type { Fragment } from "../src/lib/domain/memory";

const fragmentId = "gemma-local-integration-fragment";
const sourceText = "At Bluebird Cafe, we shared coffee after soccer practice with Alice.";

function textFragment(textContent = sourceText): Fragment {
  const now = new Date("2026-10-04T10:00:00.000Z");
  return {
    id: fragmentId,
    groupId: "gemma-local-integration-group",
    authorUserId: "gemma-local-integration-author",
    type: "text",
    storageUri: null,
    caption: null,
    textContent,
    source: "text",
    capturedTimeZone: "UTC",
    checksumSha256: null,
    processingVersion: "gemma-local-integration-v1",
    capturedAt: now,
    createdAt: now,
    metadata: {},
    visibility: "group",
    aiProcessingConsent: true,
    aiProcessingConsentAt: now,
    aiProcessingConsentRevokedAt: null,
    transcriptionConsent: false,
    transcriptionConsentAt: null,
    transcriptionConsentRevokedAt: null,
    transcriptReviewedAt: null,
    deletionState: "active",
    deletionRequestedAt: null,
    deletionRequestedByUserId: null,
    status: "processing",
  };
}

function imageFragment(): Fragment {
  const fragment = textFragment();
  return {
    ...fragment,
    id: "gemma-image-cache-fragment",
    type: "image",
    source: "upload",
    storageUri: "group-media://private-image",
    textContent: null,
    checksumSha256: "a".repeat(64),
    metadata: { mimeType: "image/jpeg" },
  };
}

function validObservation(_input: StructuredGenerationInput): Record<string, unknown> {
  const evidence = (value: string, type: string, quote: string) => ({
    type,
    value,
    confidence: 0.9,
    evidence: {
      fragment_id: fragmentId,
      modality: "text",
      locator: null,
      evidence: quote,
    },
  });
  return {
    fragment_id: fragmentId,
    summary: "we shared coffee after soccer practice",
    observed_facts: [
      evidence("Bluebird Cafe", "place", "At Bluebird Cafe"),
      evidence("soccer practice", "activity", "after soccer practice"),
    ],
    people: ["Alice"],
    entities: ["Bluebird Cafe", "coffee", "soccer"],
    location_hint: "Bluebird Cafe",
    activity_hint: "soccer practice",
    tone_hint: null,
    confidence: 0.9,
    uncertainty: { status: "possible", reason: "The supplied text names a place and activity." },
    evidence_fragment_ids: [fragmentId],
  };
}

test("unchanged fragment observations are reused without another Gemma call", async () => {
  let calls = 0;
  const provider: FragmentAnalysisGenerator = {
    modelVersion: "gemma4:e2b-test",
    async generateStructured(input) {
      calls += 1;
      return validObservation(input);
    },
  };
  const fragment = textFragment();
  const first = await generateFragmentAnalysis(fragment, provider);
  const second = await generateOrReuseFragmentAnalysis({
    fragment,
    existingAnalysis: first,
    provider,
  });

  assert.equal(calls, 1);
  assert.equal(second.sourceContentSha256, first.sourceContentSha256);
  assert.deepEqual(second.observedFacts, first.observedFacts);
});

test("duplicate image media reuses its validated observation without inference", async () => {
  let calls = 0;
  let mediaLoads = 0;
  const provider: FragmentAnalysisGenerator = {
    modelVersion: "gemma4:e2b-test",
    async generateStructured() {
      calls += 1;
      return {
        fragment_id: "gemma-image-cache-fragment",
        summary: "a red cup",
        observed_facts: [{
          type: "object",
          value: "red cup",
          confidence: 0.6,
          evidence: {
            fragment_id: "gemma-image-cache-fragment",
            modality: "image",
            locator: "whole_image",
            evidence: "a red cup",
          },
        }],
        people: [],
        entities: ["red cup"],
        location_hint: null,
        activity_hint: null,
        tone_hint: null,
        confidence: 0.6,
        uncertainty: { status: "possible", reason: "The object may be a cup." },
        evidence_fragment_ids: ["gemma-image-cache-fragment"],
      };
    },
  };
  const fragment = imageFragment();
  const loadMedia = async () => {
    mediaLoads += 1;
    return {
      images: [new Uint8Array([1, 2, 3])],
      evidenceLocators: ["whole_image"],
    };
  };
  const first = await generateOrReuseFragmentAnalysis({
    fragment,
    existingAnalysis: null,
    provider,
    loadMedia,
  });
  const second = await generateOrReuseFragmentAnalysis({
    fragment,
    existingAnalysis: first,
    provider,
    loadMedia,
  });

  assert.equal(calls, 1);
  assert.equal(mediaLoads, 1);
  assert.equal(second.sourceContentSha256, first.sourceContentSha256);
});

test("local Gemma processes a fragment into a validated observation", {
  skip: process.env.RUN_GEMMA_INTEGRATION !== "true",
}, async () => {
  const model = process.env.GEMMA_MODEL ?? "gemma4:e2b";
  const service = createGemmaService({
    NODE_ENV: "test",
    GEMMA_RUNTIME: "local",
    GEMMA_MODEL: model,
    OLLAMA_HOST: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    GEMMA_TIMEOUT_MS: process.env.GEMMA_TIMEOUT_MS ?? "300000",
  });
  const observation = await generateFragmentAnalysis(textFragment("Alice."), service);

  assert.equal(observation.fragmentId, fragmentId);
  assert.equal(observation.modelVersion, model);
  assert.ok(observation.evidenceFragmentIds.includes(fragmentId));
  assert.ok(["possible", "unknown"].includes(observation.uncertainty.status));
  for (const fact of observation.observedFacts) {
    assert.equal(fact.evidence.fragmentId, fragmentId);
    assert.ok(fact.evidence.evidence.includes(fact.value));
  }
});
