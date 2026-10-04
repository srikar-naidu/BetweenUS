import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEventStoryContextPacket,
  createDeterministicEventStory,
  generateEventStory,
  validateEventStoryResponse,
} from "../src/lib/pipeline/event-story-generation";
import { GemmaProviderError } from "../src/lib/ai/gemma-provider";
import { fragmentSourceDigest, type FragmentAnalysis } from "../src/lib/ai/fragment-analysis";
import type { Fragment, Moment } from "../src/lib/domain/memory";

const capturedAt = new Date("2026-10-04T10:00:00Z");

function fragment(id: string, type: Fragment["type"]): Fragment {
  const isVoice = type === "voice";
  return {
    id,
    groupId: "group-a",
    authorUserId: "member-a",
    type,
    storageUri: `mongodb-gridfs://${id}`,
    caption: null,
    textContent: isVoice ? "We got here just before sunset." : null,
    source: isVoice ? "upload" : "upload",
    capturedTimeZone: "UTC",
    checksumSha256: "a".repeat(64),
    processingVersion: "ingest-v1",
    capturedAt,
    createdAt: capturedAt,
    metadata: { mimeType: isVoice ? "audio/wav" : type === "video" ? "video/mp4" : "image/jpeg" },
    visibility: "group",
    aiProcessingConsent: true,
    aiProcessingConsentAt: capturedAt,
    aiProcessingConsentRevokedAt: null,
    transcriptionConsent: isVoice,
    transcriptionConsentAt: isVoice ? capturedAt : null,
    transcriptionConsentRevokedAt: null,
    transcriptReviewedAt: isVoice ? capturedAt : null,
    deletionState: "active",
    deletionRequestedAt: null,
    deletionRequestedByUserId: null,
    status: "processed",
  };
}

function analysis(source: Fragment): FragmentAnalysis {
  const modality = source.type === "image"
    ? "image"
    : source.type === "video"
      ? "video_frame"
      : "voice_transcript";
  return {
    id: `analysis-${source.id}`,
    groupId: source.groupId,
    fragmentId: source.id,
    authorUserId: source.authorUserId,
    analysisVersion: "fragment-analysis-v2",
    modelVersion: "gemma4:e2b",
    sourceContentSha256: fragmentSourceDigest(source),
    summary: source.type === "voice" ? "A reviewed voice note mentions sunset." : `Gemma observed ${source.type} evidence.`,
    observedFacts: [{
      type: "activity",
      value: source.type === "voice" ? "arrived before sunset" : "people gathered outdoors",
      confidence: 0.7,
      evidence: {
        fragmentId: source.id,
        modality,
        locator: source.type === "video" ? "frame_1" : null,
        evidence: "Directly supported source detail.",
      },
    }],
    people: [],
    entities: [],
    locationHint: null,
    activityHint: null,
    toneHint: null,
    confidence: 0.7,
    uncertainty: { status: "possible", reason: "Details remain tentative." },
    evidenceFragmentIds: [source.id],
    requiresReview: source.type !== "voice",
    analyzedAt: capturedAt,
  };
}

function moment(evidenceIds: string[]): Moment {
  return {
    id: "moment-a",
    groupId: "group-a",
    title: "Meeting before sunset",
    summary: "The group met before sunset.",
    confidence: 0.8,
    uncertaintyLabel: "confirmed",
    uncertaintyReason: "Reviewed by group members.",
    startAt: capturedAt,
    endAt: new Date(capturedAt.getTime() + 60_000),
    status: "confirmed",
    evidence: evidenceIds.map((fragmentId) => ({ fragmentId, relationship: "temporal" })),
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
}

test("Gemma event-story generation uses all selected consented observations and reviewed voice transcript facts", async () => {
  const fragments = [
    fragment("fragment-image", "image"),
    fragment("fragment-video", "video"),
    fragment("fragment-voice", "voice"),
  ];
  const analyses = fragments.map(analysis);
  let receivedPacket: unknown;
  const generated = await generateEventStory({
    groupId: "group-a",
    moments: [moment(fragments.map((source) => source.id))],
    fragments,
    analyses,
    generator: {
      async generateStructured(input) {
        receivedPacket = input.contextPacket;
        return {
          title: "Before sunset",
          sections: [{
            text: "The group gathered outdoors before sunset.",
            evidence_fragment_ids: fragments.map((source) => source.id),
            uncertainty: "grounded",
          }],
        };
      },
    },
  });

  assert.equal(generated.title, "Before sunset");
  assert.equal(generated.generationMethod, "gemma");
  assert.equal(generated.momentIds[0], "moment-a");
  assert.equal(generated.evidenceReferences[0]?.fragmentIds.length, 3);
  const packet = receivedPacket as {
    event: { moments: Array<{ sources: Array<{ fragment_id: string; media_type: string }> }> };
  };
  assert.deepEqual(
    packet.event.moments[0]?.sources.map((source) => source.media_type),
    ["image", "video", "voice"],
  );
});

test("event-story generation falls back to a chronological evidence-linked recap when Gemma is unavailable", async () => {
  const firstMoment = moment(["fragment-image"]);
  const secondMoment = {
    ...moment(["fragment-video"]),
    id: "moment-b",
    title: "Walking home",
    summary: "The group walked home together.",
    startAt: new Date(capturedAt.getTime() + 10 * 60_000),
  };
  const fragments = [fragment("fragment-image", "image"), fragment("fragment-video", "video")];
  const generated = await generateEventStory({
    groupId: "group-a",
    moments: [secondMoment, firstMoment],
    fragments,
    analyses: fragments.map(analysis),
    generator: () => ({
      async generateStructured() {
        throw new GemmaProviderError("Could not reach the configured Gemma runtime");
      },
    }),
  });

  assert.equal(generated.generationMethod, "deterministic");
  assert.equal(generated.momentIds[0], "moment-a");
  assert.match(generated.narrative, /^Moment 1: Meeting before sunset\./);
  assert.ok(generated.narrative.indexOf("Moment 1:") < generated.narrative.indexOf("Moment 2:"));
  assert.deepEqual(generated.evidenceReferences.map((reference) => reference.fragmentIds), [
    ["fragment-image"],
    ["fragment-video"],
  ]);
});

test("deterministic story fallback rejects an empty Moment packet", () => {
  assert.throws(
    () => createDeterministicEventStory({ version: "event-story-context-v1", moments: [] }),
    /at least one confirmed Moment/,
  );
});

test("invalid Gemma story output is rejected instead of silently using the fallback", async () => {
  const source = fragment("fragment-image", "image");
  await assert.rejects(
    generateEventStory({
      groupId: "group-a",
      moments: [moment([source.id])],
      fragments: [source],
      analyses: [analysis(source)],
      generator: {
        async generateStructured() {
          return { title: "Invalid", sections: [] };
        },
      },
    }),
    /Gemma returned an invalid event-story structure/,
  );
});

test("Gemma event-story validation rejects unsupported evidence references", () => {
  const source = fragment("fragment-image", "image");
  const packet = buildEventStoryContextPacket({
    groupId: "group-a",
    moments: [moment([source.id])],
    fragments: [source],
    analyses: [analysis(source)],
  });
  assert.throws(
    () => validateEventStoryResponse({
      title: "Unsupported",
      sections: [{
        text: "A detail not backed by this album.",
        evidence_fragment_ids: ["fragment-other-group"],
        uncertainty: "grounded",
      }],
    }, packet),
    /supporting evidence/,
  );
});

test("Gemma event-story validation rejects media whose AI consent has been revoked", () => {
  const source = { ...fragment("fragment-image", "image"), aiProcessingConsent: false };
  assert.throws(
    () => buildEventStoryContextPacket({
      groupId: "group-a",
      moments: [moment([source.id])],
      fragments: [source],
      analyses: [analysis(source)],
    }),
    /consented Gemma observations/,
  );
});
