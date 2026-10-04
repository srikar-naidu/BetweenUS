import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("visual output that fails evidence validation gets one constrained correction attempt", async () => {
  const fragment = imageFragment();
  const makeOutput = (value: string) => ({
    fragment_id: fragment.id,
    summary: "",
    observed_facts: [{
      type: "object",
      value,
      confidence: 0.6,
      evidence: {
        fragment_id: fragment.id,
        modality: "image",
        locator: value === "red mug" ? "unavailable_region" : "whole_image",
        evidence: "A cup sits on a table.",
      },
    }],
    people: [],
    entities: [value],
    location_hint: null,
    activity_hint: null,
    tone_hint: null,
    confidence: 0.6,
    uncertainty: { status: "possible", reason: "The visible object is uncertain." },
    evidence_fragment_ids: [fragment.id],
  });
  const tasks: string[] = [];
  const outputs = [makeOutput("red mug"), makeOutput("cup")];
  const provider: FragmentAnalysisGenerator = {
    modelVersion: "gemma4:e2b-test",
    async generateStructured(input) {
      tasks.push(input.task);
      const output = outputs.shift();
      assert.ok(output);
      return output;
    },
  };

  const analysis = await generateFragmentAnalysis(fragment, provider, {
    images: [new Uint8Array([1, 2, 3])],
    evidenceLocators: ["whole_image"],
  });

  assert.deepEqual(tasks, ["analyze_visual_fragment", "repair_visual_fragment_observations"]);
  assert.deepEqual(analysis.observedFacts.map((fact) => fact.value), ["cup"]);
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

test("local Gemma analyzes an image into grounded observations", {
  skip: process.env.RUN_GEMMA_VISION_INTEGRATION !== "true" ||
    !process.env.GEMMA_TEST_IMAGE,
}, async () => {
  const imageFragment = {
    ...textFragment(),
    id: `${fragmentId}-image`,
    type: "image" as const,
    source: "upload" as const,
    storageUri: "group-media://integration-test-image",
    textContent: null,
    checksumSha256: "a".repeat(64),
    metadata: { mimeType: "image/jpeg" },
  };
  const model = process.env.GEMMA_MODEL ?? "gemma4:e2b";
  const service = createGemmaService({
    NODE_ENV: "test",
    GEMMA_RUNTIME: "local",
    GEMMA_MODEL: model,
    OLLAMA_HOST: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    GEMMA_TIMEOUT_MS: process.env.GEMMA_TIMEOUT_MS ?? "300000",
  });
  const bytes = await readFile(process.env.GEMMA_TEST_IMAGE!);
  const observation = await generateFragmentAnalysis(imageFragment, service, {
    images: [bytes],
    evidenceLocators: ["whole_image"],
  });

  assert.equal(observation.fragmentId, imageFragment.id);
  assert.equal(observation.modelVersion, model);
  assert.ok(observation.confidence <= 0.7);
  assert.ok(["possible", "unknown"].includes(observation.uncertainty.status));
  for (const fact of observation.observedFacts) {
    assert.equal(fact.evidence.fragmentId, imageFragment.id);
    assert.equal(fact.evidence.modality, "image");
    assert.equal(fact.evidence.locator, "whole_image");
    assert.ok(fact.evidence.evidence.length > 0);
    assert.ok(fact.confidence <= 0.7);
  }
});
