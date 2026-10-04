import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { fragmentSourceDigest, FRAGMENT_ANALYSIS_VERSION } from "@/lib/ai/fragment-analysis";
import { createGemmaService, type StructuredGenerationInput } from "@/lib/ai/gemma-provider";
import type {
  Fragment,
  Moment,
  Story,
  StoryEvidence,
  StoryRelationship,
} from "@/lib/domain/memory";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoFragmentAnalysisRepository } from "@/lib/repositories/mongodb-fragment-analysis-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoStoryRepository } from "@/lib/repositories/mongodb-story-repository";

export const STORY_RECONSTRUCTION_VERSION = "story-reconstruction-v1";
export const MAX_STORY_MOMENTS = 8;
export const MAX_STORY_FRAGMENTS_PER_MOMENT = 2;

export interface StoryContextMoment {
  moment_id: string;
  moment_revision: number;
  start_at: string;
  end_at: string;
  title: string | null;
  summary: string;
  source_fragments: Array<{
    fragment_id: string;
    facts: Array<{
      type: string;
      value: string;
      modality: string;
    }>;
    entities: string[];
  }>;
}

export interface StoryContextPacket {
  version: "story-context-v1";
  moments: StoryContextMoment[];
}

export interface ValidatedStoryProposal {
  title: string;
  summary: string;
  confidence: number;
  evidence: Array<{ momentId: string; relationship: StoryRelationship }>;
}

export interface StoryReconstructionResult {
  outcome: "candidate" | "insufficient_evidence";
  story: Story | null;
}

export interface StoryReconstructionGenerator {
  readonly modelVersion: string;
  generateStructured(input: StructuredGenerationInput): Promise<Record<string, unknown>>;
}

const storyRelationships: readonly StoryRelationship[] = [
  "shared_people",
  "same_location",
  "recurring_theme",
  "timeline_connection",
];

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function significantWords(value: string): Set<string> {
  const stopWords = new Set(["about", "after", "from", "into", "that", "the", "this", "with"]);
  return new Set(value.toLocaleLowerCase().split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !stopWords.has(word)));
}

export function buildStoryContextPacket(input: {
  groupId: string;
  moments: readonly Moment[];
  fragments: readonly Fragment[];
  analyses: readonly {
    groupId: string;
    fragmentId: string;
    sourceContentSha256: string;
    observedFacts: Array<{
      type: string;
      value: string;
      evidence: { modality: string };
    }>;
    entities: string[];
  }[];
}): StoryContextPacket {
  const eligibleFragments = new Map(input.fragments
    .filter((fragment) =>
      fragment.groupId === input.groupId &&
      fragment.visibility === "group" &&
      fragment.aiProcessingConsent &&
      fragment.deletionState === "active",
    )
    .map((fragment) => [fragment.id, fragment]));
  const analyses = new Map(input.analyses
    .filter((analysis) => analysis.groupId === input.groupId)
    .map((analysis) => [analysis.fragmentId, analysis]));

  const candidates: StoryContextMoment[] = input.moments
    .filter((moment) => moment.groupId === input.groupId && moment.status === "confirmed")
    .flatMap((moment) => {
      if (!moment.evidence.length) return [];
      const sourceFragments = moment.evidence.map(({ fragmentId }) => {
        const fragment = eligibleFragments.get(fragmentId);
        const analysis = analyses.get(fragmentId);
        if (!fragment || !analysis || analysis.sourceContentSha256 !== fragmentSourceDigest(fragment)) {
          return null;
        }
        return {
          fragment_id: fragmentId,
          facts: analysis.observedFacts.slice(0, 3).map((fact) => ({
            type: fact.type,
            value: fact.value.slice(0, 80),
            modality: fact.evidence.modality,
          })),
          entities: analysis.entities.slice(0, 4).map((entity) => entity.slice(0, 60)),
        };
      });
      if (sourceFragments.some((fragment) => fragment === null)) return [];
      return [{
        moment_id: moment.id,
        moment_revision: moment.revision ?? 0,
        start_at: moment.startAt.toISOString(),
        end_at: moment.endAt.toISOString(),
        title: moment.title,
        summary: moment.summary.slice(0, 300),
        source_fragments: sourceFragments.filter(
          (fragment): fragment is NonNullable<typeof fragment> => fragment !== null,
        ).slice(0, MAX_STORY_FRAGMENTS_PER_MOMENT),
      }];
    });

  const relevanceScore = (moment: StoryContextMoment) =>
    candidates.reduce((score, peer) => {
      if (peer.moment_id === moment.moment_id) return score;
      const matches = storyRelationships.filter((relationship) =>
        relationshipSupported(relationship, moment, peer),
      );
      return score + (matches.includes("shared_people") || matches.includes("same_location")
        ? 3
        : matches.includes("recurring_theme")
          ? 2
          : matches.includes("timeline_connection")
            ? 1
            : 0);
    }, 0);
  candidates.sort((left, right) =>
    relevanceScore(right) - relevanceScore(left) ||
    Date.parse(right.start_at) - Date.parse(left.start_at),
  );
  return {
    version: "story-context-v1",
    moments: candidates.slice(0, MAX_STORY_MOMENTS),
  };
}

export function storyConnectionResponseSchema(
  packet: StoryContextPacket,
): Record<string, unknown> {
  const momentIds = packet.moments.map((moment) => moment.moment_id);
  return {
    type: "object",
    properties: {
      title: { type: ["string", "null"], maxLength: 120 },
      summary: { type: ["string", "null"], maxLength: 500 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidence: {
        type: "array",
        maxItems: momentIds.length,
        items: {
          type: "object",
          properties: {
            moment_id: { type: "string", enum: momentIds },
            relationship: { type: "string", enum: storyRelationships },
          },
          required: ["moment_id", "relationship"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "summary", "confidence", "evidence"],
    additionalProperties: false,
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Gemma returned invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new TypeError(`Gemma returned invalid ${label}`);
  }
  return value.trim();
}

function sharedValue(
  left: StoryContextMoment,
  right: StoryContextMoment,
  factType: "person" | "place",
): string | null {
  const values = (moment: StoryContextMoment) => new Set(moment.source_fragments
    .flatMap((fragment) => fragment.facts
      .filter((fact) =>
        fact.type === factType &&
        (fact.modality === "text" || fact.modality === "voice_transcript"),
      )
      .map((fact) => normalized(fact.value))));
  const rightValues = values(right);
  return [...values(left)].find((value) => rightValues.has(value)) ?? null;
}

function relationshipSupported(
  relationship: StoryRelationship,
  left: StoryContextMoment,
  right: StoryContextMoment,
): boolean {
  if (relationship === "shared_people") {
    return sharedValue(left, right, "person") !== null;
  }
  if (relationship === "same_location") {
    return sharedValue(left, right, "place") !== null;
  }
  if (relationship === "timeline_connection") {
    const leftEnd = Date.parse(left.end_at);
    const rightStart = Date.parse(right.start_at);
    const rightEnd = Date.parse(right.end_at);
    const leftStart = Date.parse(left.start_at);
    const gap = Math.max(0, Math.max(leftStart, rightStart) - Math.min(leftEnd, rightEnd));
    return gap <= 30 * 24 * 60 * 60_000;
  }
  const terms = (moment: StoryContextMoment) => {
    const source = moment.source_fragments.flatMap((fragment) =>
      [...fragment.entities, ...fragment.facts
        .filter((fact) => fact.type !== "person")
        .map((fact) => fact.value)],
    ).join(" ");
    return significantWords(`${source} ${moment.summary} ${moment.title ?? ""}`);
  };
  const rightTerms = terms(right);
  let overlap = 0;
  for (const term of terms(left)) if (rightTerms.has(term)) overlap += 1;
  return overlap >= 2;
}

export function validateStoryConnectionOutput(
  result: Record<string, unknown>,
  packet: StoryContextPacket,
): ValidatedStoryProposal | null {
  if (
    typeof result.confidence !== "number" ||
    !Number.isFinite(result.confidence) ||
    result.confidence < 0 ||
    result.confidence > 1 ||
    !Array.isArray(result.evidence) ||
    result.evidence.length > packet.moments.length
  ) {
    throw new TypeError("Gemma returned invalid Story evidence or confidence");
  }
  const evidence = result.evidence.map((entry): { momentId: string; relationship: StoryRelationship } => {
    const value = objectValue(entry, "Story evidence");
    if (
      typeof value.moment_id !== "string" ||
      typeof value.relationship !== "string" ||
      !storyRelationships.includes(value.relationship as StoryRelationship)
    ) {
      throw new TypeError("Gemma cited invalid Story evidence");
    }
    return {
      momentId: value.moment_id,
      relationship: value.relationship as StoryRelationship,
    };
  });
  if (new Set(evidence.map((item) => item.momentId)).size !== evidence.length) {
    throw new TypeError("Gemma returned duplicate Story evidence");
  }
  const momentsById = new Map(packet.moments.map((moment) => [moment.moment_id, moment]));
  if (evidence.some((item) => !momentsById.has(item.momentId))) {
    throw new TypeError("Gemma cited a Moment outside the authorized Story context");
  }
  if (evidence.length < 2) {
    if (result.title !== null || result.summary !== null) {
      throw new TypeError("Gemma returned a Story without at least two cited Moments");
    }
    return null;
  }
  for (const item of evidence) {
    const moment = momentsById.get(item.momentId);
    if (!moment) throw new TypeError("Gemma cited a Moment outside the authorized Story context");
    const peers = evidence.filter((peer) => peer.momentId !== item.momentId)
      .map((peer) => momentsById.get(peer.momentId))
      .filter((peer): peer is StoryContextMoment => peer !== undefined);
    if (!peers.some((peer) => relationshipSupported(item.relationship, moment, peer))) {
      throw new TypeError(`Gemma assigned unsupported ${item.relationship} evidence`);
    }
  }
  return {
    title: boundedString(result.title, "Story title", 120),
    summary: boundedString(result.summary, "Story summary", 500),
    confidence: result.confidence,
    evidence,
  };
}

export function deriveStorySourceKey(
  moments: readonly Moment[],
  modelVersion = "",
): string {
  const material = moments.map((moment) => [
    moment.id,
    moment.revision ?? 0,
    moment.updatedAt.toISOString(),
    ...moment.evidence.map(({ fragmentId }) => fragmentId).sort(),
  ].join("\0")).sort();
  return createHash("sha256")
    .update(`${STORY_RECONSTRUCTION_VERSION}\0${modelVersion}\0${material.join("\n")}`)
    .digest("hex");
}

export function deriveStoryContextKey(
  packet: StoryContextPacket,
  modelVersion: string,
  sourceDigests: readonly { fragmentId: string; sourceContentSha256: string }[] = [],
): string {
  const digestMaterial = [...sourceDigests]
    .sort((left, right) => left.fragmentId.localeCompare(right.fragmentId))
    .map(({ fragmentId, sourceContentSha256 }) => `${fragmentId}\0${sourceContentSha256}`)
    .join("\n");
  return createHash("sha256")
    .update(`${STORY_RECONSTRUCTION_VERSION}\0${modelVersion}\0${JSON.stringify(packet)}\0${digestMaterial}`)
    .digest("hex");
}

function storyEvidence(
  evidence: ValidatedStoryProposal["evidence"],
  moments: readonly Moment[],
  sourceDigests: ReadonlyMap<string, string>,
): StoryEvidence[] {
  const momentsById = new Map(moments.map((moment) => [moment.id, moment]));
  return evidence.map((item) => {
    const fragmentIds = momentsById.get(item.momentId)?.evidence
      .map(({ fragmentId }) => fragmentId) ?? [];
    return {
      momentId: item.momentId,
      momentRevision: momentsById.get(item.momentId)?.revision ?? 0,
      relationship: item.relationship,
      fragmentIds,
      fragmentSourceDigests: fragmentIds.flatMap((fragmentId) => {
        const sourceContentSha256 = sourceDigests.get(fragmentId);
        return sourceContentSha256 ? [{ fragmentId, sourceContentSha256 }] : [];
      }),
    };
  });
}

export async function reconstructStoryConnection(input: {
  groupId: string;
  storyId?: string;
  generator?: StoryReconstructionGenerator;
  database?: Db;
  authorizationCheck: () => Promise<void>;
}): Promise<StoryReconstructionResult> {
  const database = input.database ?? await getMongoDatabase();
  await input.authorizationCheck();
  const memory = new MongoMemoryRepository(database);
  const moments = (await memory.listMoments(input.groupId, 100))
    .filter((moment) => moment.status === "confirmed");
  const fragmentIds = [...new Set(moments.flatMap((moment) =>
    moment.evidence.map(({ fragmentId }) => fragmentId),
  ))];
  const fragments = await memory.findEligibleGroupVisibleFragmentsByIds(input.groupId, fragmentIds);
  const analyses = await new MongoFragmentAnalysisRepository(database)
    .findMany(input.groupId, fragmentIds, FRAGMENT_ANALYSIS_VERSION);
  const packet = buildStoryContextPacket({
    groupId: input.groupId,
    moments,
    fragments,
    analyses,
  });
  if (packet.moments.length < 2) return { outcome: "insufficient_evidence", story: null };

  const generator = input.generator ?? createGemmaService();
  const analysesByFragment = new Map(analyses.map((analysis) => [analysis.fragmentId, analysis]));
  const packetSourceDigests = packet.moments.flatMap((moment) =>
    moment.source_fragments.flatMap(({ fragment_id }) => {
      const analysis = analysesByFragment.get(fragment_id);
      return analysis
        ? [{ fragmentId: fragment_id, sourceContentSha256: analysis.sourceContentSha256 }]
        : [];
    }),
  );
  const contextKey = deriveStoryContextKey(packet, generator.modelVersion, packetSourceDigests);
  const storyRepository = new MongoStoryRepository(database);
  const cachedStory = await storyRepository.findStoryByContextKey(input.groupId, contextKey);
  if (cachedStory) {
    return cachedStory.status === "rejected"
      ? { outcome: "insufficient_evidence", story: null }
      : { outcome: "candidate", story: cachedStory };
  }
  let proposal: ValidatedStoryProposal | null = null;
  const result = await generator.generateStructured({
    task: "reconstruct_story_connection",
    think: true,
    contextPacket: {
      ...packet,
      constraints: [
        "Find at most one recurring Story connection across distinct, member-confirmed Moments.",
        "Use only the supplied Moments and source observations; cite only their moment_id values.",
        "A relationship must be directly supported by repeated, exact evidence or timestamps.",
        "Do not infer identity from visual evidence, or infer a relationship between people from appearance.",
        "If no supported pattern connects at least two Moments, return null title and summary and an empty evidence array.",
        "Return a possible, reviewable hypothesis only; never confirm a Story or claim certainty.",
      ],
    },
    responseSchema: storyConnectionResponseSchema(packet),
  });
  proposal = validateStoryConnectionOutput(result, packet);

  if (!proposal) return { outcome: "insufficient_evidence", story: null };

  const selectedMoments = moments.filter((moment) =>
    proposal?.evidence.some((item) => item.momentId === moment.id),
  );
  const selectedIds = new Set(selectedMoments.map((moment) => moment.id));
  const selectedFragmentIds = new Set(selectedMoments.flatMap((moment) =>
    moment.evidence.map(({ fragmentId }) => fragmentId),
  ));
  const currentSources = await memory.findEligibleGroupVisibleFragmentsByIds(
    input.groupId,
    [...selectedFragmentIds],
  );
  const currentMoments = await Promise.all([...selectedIds].map((momentId) =>
    memory.findMoment(input.groupId, momentId),
  ));
  const currentAnalyses = await new MongoFragmentAnalysisRepository(database)
    .findMany(input.groupId, [...selectedFragmentIds], FRAGMENT_ANALYSIS_VERSION);
  const currentAnalysisByFragment = new Map(currentAnalyses.map((analysis) => [analysis.fragmentId, analysis]));
  const currentSourcesAreUnchanged = currentSources.every((fragment) => {
    const analysis = currentAnalysisByFragment.get(fragment.id);
    return analysis !== undefined &&
      analysis.sourceContentSha256 === fragmentSourceDigest(fragment);
  });
  const momentEvidenceUnchanged = selectedMoments.every((selectedMoment) => {
    const current = currentMoments.find((moment) => moment?.id === selectedMoment.id);
    return current?.status === "confirmed" &&
      (current.revision ?? 0) === (selectedMoment.revision ?? 0) &&
      current.updatedAt.getTime() === selectedMoment.updatedAt.getTime() &&
      current.evidence.map(({ fragmentId }) => fragmentId).sort().join("\0") ===
        selectedMoment.evidence.map(({ fragmentId }) => fragmentId).sort().join("\0");
  });
  if (
    currentSources.length !== selectedFragmentIds.size ||
    !currentSourcesAreUnchanged ||
    !momentEvidenceUnchanged
  ) {
    throw new Error("Story evidence changed eligibility before it could be saved");
  }
  await input.authorizationCheck();

  const startTimes = selectedMoments.map((moment) => moment.startAt.getTime());
  const endTimes = selectedMoments.map((moment) => moment.endAt.getTime());
  const now = new Date();
  const story: Story = {
    id: input.storyId ?? randomUUID(),
    groupId: input.groupId,
    title: proposal.title,
    summary: proposal.summary,
    confidence: proposal.confidence,
    uncertaintyLabel: "possible",
    uncertaintyReason: "The recurring connection is evidence-linked but has not been confirmed by group members.",
    startAt: new Date(Math.min(...startTimes)),
    endAt: new Date(Math.max(...endTimes)),
    momentIds: proposal.evidence.map(({ momentId }) => momentId),
    evidence: storyEvidence(
      proposal.evidence,
      selectedMoments,
      new Map(currentSources.map((fragment) => [fragment.id, fragmentSourceDigest(fragment)])),
    ),
    status: "candidate",
    modelVersion: generator.modelVersion,
    reconstructionVersion: STORY_RECONSTRUCTION_VERSION,
    sourceKey: deriveStorySourceKey(selectedMoments, generator.modelVersion),
    contextKey,
    reviewHistory: [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
  const saved = await storyRepository.insertStoryIfAbsent(story);
  if (saved.status === "rejected") return { outcome: "insufficient_evidence", story: null };
  return { outcome: "candidate", story: saved };
}
