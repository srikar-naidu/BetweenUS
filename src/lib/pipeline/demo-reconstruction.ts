import type {
  Fragment,
  Moment,
  MomentEvidence,
  TemporalFragmentQuery,
} from "@/lib/domain/memory";
import { getMongoDatabase } from "@/lib/db/mongodb";
import {
  createGemmaService,
  type StructuredGenerationInput,
} from "@/lib/ai/gemma-provider";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { TigerDataFragmentSearch } from "@/lib/retrieval/tiger-data";
import { MAX_CONTEXT_CANDIDATES, rankFragmentCandidates } from "@/lib/retrieval/ranking";

export interface DemoFragment extends Fragment {
  semanticSummary: string;
  entityKeys: string[];
  locationKeys: string[];
}

export interface DemoCandidate extends DemoFragment {
  retrievalScore: number;
}

export interface DemoPipelineResult {
  outcome: "candidate";
  group: { id: string; name: string };
  anchorFragmentId: string;
  candidateFragments: DemoFragment[];
  moment: Moment;
}

export interface InsufficientEvidenceResult {
  outcome: "insufficient_evidence";
  group: { id: string; name: string };
  anchorFragmentId: string;
  candidateFragments: DemoFragment[];
  uncertaintyLabel: "unknown";
  uncertaintyReason: string;
}

export type DemoReconstructionResult = DemoPipelineResult | InsufficientEvidenceResult;

export interface DemoPipelineAdapters {
  findCandidates(query: TemporalFragmentQuery): Promise<DemoCandidate[]>;
  saveMoment(moment: Moment): Promise<Moment>;
}

interface DemoRuntimeCache {
  moments: Map<string, Moment>;
}

interface Reconstructor {
  generateStructured(
    input: StructuredGenerationInput,
  ): Promise<Record<string, unknown>>;
}

const globalForDemo = globalThis as typeof globalThis & {
  betweenUsDemo?: DemoRuntimeCache;
};

const demoCache = (globalForDemo.betweenUsDemo ??= {
  moments: new Map<string, Moment>(),
});

const group = { id: "group-between-us-demo", name: "The Cafeteria Crew" };

const sampleFragments: DemoFragment[] = [
  {
    id: "demo-fragment-a",
    groupId: group.id,
    authorUserId: "maya",
    type: "image",
    storageUri: "demo://cafeteria/table",
    textContent: null,
    source: "demo",
    capturedTimeZone: "UTC",
    checksumSha256: null,
    processingVersion: "demo-v1",
    caption: "A table of fries and three cold coffees at the cafeteria.",
    semanticSummary: "Cafeteria table with fries, three coffees, and friends gathering.",
    entityKeys: ["cafeteria", "fries", "coffee"],
    locationKeys: ["cafeteria"],
    capturedAt: new Date("2026-09-04T12:04:00Z"),
    createdAt: new Date("2026-09-04T12:04:00Z"),
    metadata: { mimeType: "image/jpeg" },
    visibility: "group",
    aiProcessingConsent: true,
    aiProcessingConsentAt: new Date("2026-09-04T12:04:00Z"),
    aiProcessingConsentRevokedAt: null,
    deletionState: "active",
    deletionRequestedAt: null,
    deletionRequestedByUserId: null,
    status: "processed",
  },
  {
    id: "demo-fragment-b",
    groupId: group.id,
    authorUserId: "arjun",
    type: "screenshot",
    storageUri: "demo://cafeteria/group-chat",
    textContent: null,
    source: "demo",
    capturedTimeZone: "UTC",
    checksumSha256: null,
    processingVersion: "demo-v1",
    caption: "Group chat screenshot: 'cafeteria line is moving again, hurry'.",
    semanticSummary: "A message asks friends to hurry to the cafeteria while the line moves.",
    entityKeys: ["cafeteria", "group chat"],
    locationKeys: ["cafeteria"],
    capturedAt: new Date("2026-09-04T12:09:00Z"),
    createdAt: new Date("2026-09-04T12:09:00Z"),
    metadata: { mimeType: "image/png" },
    visibility: "group",
    aiProcessingConsent: true,
    aiProcessingConsentAt: new Date("2026-09-04T12:09:00Z"),
    aiProcessingConsentRevokedAt: null,
    deletionState: "active",
    deletionRequestedAt: null,
    deletionRequestedByUserId: null,
    status: "processed",
  },
  {
    id: "demo-fragment-c",
    groupId: group.id,
    authorUserId: "leah",
    type: "video",
    storageUri: "demo://cafeteria/cheering",
    textContent: null,
    source: "demo",
    capturedTimeZone: "UTC",
    checksumSha256: null,
    processingVersion: "demo-v1",
    caption: "Short video: everyone cheers as the cafeteria doors open.",
    semanticSummary: "Friends cheer together at the cafeteria doors shortly after lunch.",
    entityKeys: ["cafeteria", "friends", "doors"],
    locationKeys: ["cafeteria"],
    capturedAt: new Date("2026-09-04T12:16:00Z"),
    createdAt: new Date("2026-09-04T12:16:00Z"),
    metadata: { mimeType: "video/mp4", durationSeconds: 4 },
    visibility: "group",
    aiProcessingConsent: true,
    aiProcessingConsentAt: new Date("2026-09-04T12:16:00Z"),
    aiProcessingConsentRevokedAt: null,
    deletionState: "active",
    deletionRequestedAt: null,
    deletionRequestedByUserId: null,
    status: "processed",
  },
  {
    id: "demo-fragment-d",
    groupId: group.id,
    authorUserId: "maya",
    type: "text",
    storageUri: "demo://library/note",
    textContent: "Quiet study room, finally found a seat by the window.",
    source: "demo",
    capturedTimeZone: "UTC",
    checksumSha256: null,
    processingVersion: "demo-v1",
    caption: "Quiet study room, finally found a seat by the window.",
    semanticSummary: "A quiet study room in the library, away from the cafeteria.",
    entityKeys: ["library", "study room"],
    locationKeys: ["library"],
    capturedAt: new Date("2026-09-04T14:32:00Z"),
    createdAt: new Date("2026-09-04T14:32:00Z"),
    metadata: {},
    visibility: "group",
    aiProcessingConsent: true,
    aiProcessingConsentAt: new Date("2026-09-04T14:32:00Z"),
    aiProcessingConsentRevokedAt: null,
    deletionState: "active",
    deletionRequestedAt: null,
    deletionRequestedByUserId: null,
    status: "processed",
  },
];

const responseSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fragmentId: { type: "string" },
          relationship: {
            type: "string",
            enum: ["temporal", "shared_people", "shared_location", "semantic_similarity", "entity_overlap"],
          },
        },
        required: ["fragmentId", "relationship"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "confidence", "evidence"],
  additionalProperties: false,
};

const allowedRelationships = new Set<MomentEvidence["relationship"]>([
  "temporal",
  "shared_people",
  "shared_location",
  "semantic_similarity",
  "entity_overlap",
]);

function rankDemoCandidates(query: TemporalFragmentQuery): DemoCandidate[] {
  const eligible = sampleFragments
    .filter(
      (fragment) =>
        fragment.groupId === query.groupId &&
        fragment.visibility === "group" &&
        fragment.capturedAt >= query.startAt &&
        fragment.capturedAt <= query.endAt &&
        fragment.id !== query.excludeFragmentId,
    );
  const byId = new Map(eligible.map((fragment) => [fragment.id, fragment]));
  return rankFragmentCandidates(query, eligible.map((fragment) => ({
    fragmentId: fragment.id,
    capturedAt: fragment.capturedAt,
    semanticSummary: fragment.semanticSummary,
    entityKeys: fragment.entityKeys,
    momentIds: [],
    retrievalScore: 0,
    matchedSignals: [],
  }))).flatMap((candidate) => {
    const fragment = byId.get(candidate.fragmentId);
    return fragment ? [{ ...fragment, retrievalScore: candidate.retrievalScore }] : [];
  });
}

function getMemoryAdapters(): DemoPipelineAdapters {
  return {
    async findCandidates(query) {
      return rankDemoCandidates(query);
    },
    async saveMoment(moment) {
      demoCache.moments.set(moment.id, moment);
      return moment;
    },
  };
}

async function getDatabaseAdapters(): Promise<DemoPipelineAdapters> {
  const database = await getMongoDatabase();
  const repository = new MongoMemoryRepository(database);
  const retrieval = new TigerDataFragmentSearch();
  await repository.ensureIndexes();

  for (const fragment of sampleFragments) {
    const { semanticSummary: _summary, entityKeys: _entities, ...canonical } = fragment;
    await repository.upsertFragment(canonical);
    await retrieval.indexGroupVisibleFragment({
      groupId: fragment.groupId,
      fragmentId: fragment.id,
      capturedAt: fragment.capturedAt,
      semanticSummary: fragment.semanticSummary,
      entityKeys: fragment.entityKeys,
    });
  }

  return {
    async findCandidates(query) {
      const [indexed, visible] = await Promise.all([
        retrieval.findCandidates(query),
        repository.findGroupVisibleFragments(
          query.groupId,
          query.startAt,
          query.endAt,
          query.limit,
        ),
      ]);
      const visibleIds = new Set(visible.map((fragment) => fragment.id));
      return indexed.flatMap((candidate, index) => {
        const source = sampleFragments.find(
          (fragment) =>
            fragment.id === candidate.fragmentId && visibleIds.has(fragment.id),
        );
        return source
          ? [{ ...source, retrievalScore: indexed.length - index }]
          : [];
      });
    },
    saveMoment: (moment) => repository.upsertMoment(moment),
  };
}

async function getAdapters(): Promise<DemoPipelineAdapters> {
  const hasMongo = Boolean(process.env.MONGODB_URI);
  const hasTiger = Boolean(process.env.TIGER_DATABASE_URL);
  if (!hasMongo && !hasTiger) return getMemoryAdapters();
  if (!hasMongo || !hasTiger) {
    throw new Error("Configure both MONGODB_URI and TIGER_DATABASE_URL, or neither for the local demo store");
  }
  return getDatabaseAdapters();
}

function validateModelResult(
  result: Record<string, unknown>,
  candidates: DemoCandidate[],
): { summary: string; confidence: number; evidence: MomentEvidence[] } {
  if (
    typeof result.summary !== "string" ||
    result.summary.trim().length === 0 ||
    result.summary.length > 500
  ) {
    throw new Error("Gemma returned an invalid moment summary");
  }
  if (
    typeof result.confidence !== "number" ||
    !Number.isFinite(result.confidence) ||
    result.confidence < 0 ||
    result.confidence > 1
  ) {
    throw new Error("Gemma returned an invalid confidence value");
  }
  if (!Array.isArray(result.evidence)) {
    throw new Error("Gemma returned invalid evidence");
  }

  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const evidence = result.evidence.map((item): MomentEvidence => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Gemma returned malformed evidence");
    }
    const value = item as Record<string, unknown>;
    if (
      typeof value.fragmentId !== "string" ||
      !candidateIds.has(value.fragmentId) ||
      typeof value.relationship !== "string" ||
      !allowedRelationships.has(value.relationship as MomentEvidence["relationship"])
    ) {
      throw new Error("Gemma cited evidence outside the retrieved candidate set");
    }
    return {
      fragmentId: value.fragmentId,
      relationship: value.relationship as MomentEvidence["relationship"],
    };
  });

  const uniqueEvidence = [...new Map(evidence.map((item) => [item.fragmentId, item])).values()];
  if (uniqueEvidence.length >= 2) {
    for (const item of uniqueEvidence) {
      const fragment = candidates.find((candidate) => candidate.id === item.fragmentId);
      if (!fragment || !relationshipIsSupported(item, fragment, uniqueEvidence, candidates)) {
        throw new Error(
          `Gemma assigned unsupported ${item.relationship} evidence to ${item.fragmentId}`,
        );
      }
    }
  }

  return { summary: result.summary.trim(), confidence: result.confidence, evidence: uniqueEvidence };
}

function relationshipIsSupported(
  evidence: MomentEvidence,
  fragment: DemoCandidate,
  selectedEvidence: MomentEvidence[],
  candidates: DemoCandidate[],
): boolean {
  const peers = candidates.filter(
    (candidate) =>
      candidate.id !== fragment.id &&
      selectedEvidence.some((item) => item.fragmentId === candidate.id),
  );
  if (evidence.relationship === "shared_people") return false;
  if (evidence.relationship === "temporal") {
    return peers.some(
      (peer) => Math.abs(peer.capturedAt.getTime() - fragment.capturedAt.getTime()) <= 20 * 60_000,
    );
  }
  if (evidence.relationship === "shared_location") {
    return peers.some((peer) =>
      fragment.locationKeys.some((key) => peer.locationKeys.includes(key)),
    );
  }
  if (evidence.relationship === "entity_overlap") {
    return peers.some((peer) =>
      fragment.entityKeys.some((key) => peer.entityKeys.includes(key)),
    );
  }

  const stopWords = new Set(["about", "after", "from", "into", "that", "the", "this", "with"]);
  const tokens = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .split(/\W+/)
        .filter((token) => token.length >= 4 && !stopWords.has(token)),
    );
  const fragmentTokens = tokens(fragment.semanticSummary);
  return peers.some((peer) => {
    const peerTokens = tokens(peer.semanticSummary);
    let overlap = 0;
    for (const token of fragmentTokens) {
      if (peerTokens.has(token)) overlap += 1;
    }
    return overlap >= 2;
  });
}

function insufficientEvidence(
  candidates: DemoCandidate[],
  reason: string,
): InsufficientEvidenceResult {
  return {
    outcome: "insufficient_evidence",
    group,
    anchorFragmentId: sampleFragments[1].id,
    candidateFragments: candidates,
    uncertaintyLabel: "unknown",
    uncertaintyReason: reason,
  };
}

export async function runDemoReconstruction(options: {
  adapters?: DemoPipelineAdapters;
  reconstructor?: Reconstructor;
} = {}): Promise<DemoReconstructionResult> {
  const adapters = options.adapters ?? (await getAdapters());
  const reconstructor = options.reconstructor ?? createGemmaService();
  const anchor = sampleFragments[1];
  const windowStart = new Date(anchor.capturedAt.getTime() - 20 * 60_000);
  const windowEnd = new Date(anchor.capturedAt.getTime() + 20 * 60_000);
  const candidates = await adapters.findCandidates({
    groupId: group.id,
    startAt: windowStart,
    endAt: windowEnd,
    excludeFragmentId: anchor.id,
    searchText: "cafeteria",
    entityKeys: anchor.entityKeys,
    limit: MAX_CONTEXT_CANDIDATES - 1,
  });
  const allCandidates: DemoCandidate[] = [
    { ...anchor, retrievalScore: 1 },
    ...candidates,
  ].sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime())
    .slice(0, MAX_CONTEXT_CANDIDATES);
  if (allCandidates.length < 2) {
    return insufficientEvidence(
      allCandidates,
      "Only one group-visible fragment falls in this time window, so there is not enough evidence to connect a moment.",
    );
  }
  if (new Set(allCandidates.map((fragment) => fragment.authorUserId)).size < 2) {
    return insufficientEvidence(
      allCandidates,
      "These fragments come from only one member, so we cannot establish a shared group moment yet.",
    );
  }

  const generated = await reconstructor.generateStructured({
    task: "reconstruct_possible_moment",
    contextPacket: {
      group_id: group.id,
      time_window: { start: windowStart, end: windowEnd },
      candidate_fragments: allCandidates.map((fragment) => ({
        id: fragment.id,
        author_id: fragment.authorUserId,
        timestamp: fragment.capturedAt,
        type: fragment.type,
        caption: fragment.caption?.slice(0, 500) ?? null,
        semantic_summary: fragment.semanticSummary.slice(0, 500),
        entities: fragment.entityKeys.slice(0, 20),
        retrieval_score: fragment.retrievalScore,
      })),
      constraints: [
        "Only cite fragment IDs in candidate_fragments.",
        "Do not infer details absent from the evidence.",
        "Preserve uncertainty; this is a candidate, not a confirmed event.",
      ],
    },
    responseSchema,
  });
  const validated = validateModelResult(generated, allCandidates);
  const sourceFragments = allCandidates.filter((candidate) =>
    validated.evidence.some((evidence) => evidence.fragmentId === candidate.id),
  );
  const evidenceAuthors = new Set(sourceFragments.map((fragment) => fragment.authorUserId));
  if (sourceFragments.length < 2 || evidenceAuthors.size < 2) {
    return insufficientEvidence(
      allCandidates,
      "The model did not cite enough independent fragments from different members to support a shared moment.",
    );
  }
  const spanMilliseconds =
    Math.max(...sourceFragments.map((fragment) => fragment.capturedAt.getTime())) -
    Math.min(...sourceFragments.map((fragment) => fragment.capturedAt.getTime()));
  const hasCorroboratingRelationship = validated.evidence.some(
    (item) => item.relationship !== "temporal",
  );
  const uncertaintyLabel =
    sourceFragments.length >= 3 &&
    evidenceAuthors.size >= 2 &&
    hasCorroboratingRelationship &&
    spanMilliseconds <= 20 * 60_000
      ? "likely"
      : "possible";
  const uncertaintyReason =
    uncertaintyLabel === "likely"
      ? "Three or more fragments from multiple members share a corroborating detail within 20 minutes. This remains a candidate until a group member confirms it."
      : "Multiple members contributed nearby fragments, but the evidence does not meet the stronger corroboration rule. This is only a possibility, not a confirmed moment.";
  const moment: Moment = {
    id: "demo-moment-cafeteria-2026-09-04",
    groupId: group.id,
    title: "The cafeteria rush",
    summary: validated.summary,
    confidence: validated.confidence,
    uncertaintyLabel,
    uncertaintyReason,
    startAt: new Date(Math.min(...sourceFragments.map((fragment) => fragment.capturedAt.getTime()))),
    endAt: new Date(Math.max(...sourceFragments.map((fragment) => fragment.capturedAt.getTime()))),
    status: "candidate",
    evidence: validated.evidence,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const storedMoment = await adapters.saveMoment(moment);

  return {
    outcome: "candidate",
    group,
    anchorFragmentId: anchor.id,
    candidateFragments: allCandidates,
    moment: storedMoment,
  };
}

export function getDemoFragments(): DemoFragment[] {
  return sampleFragments.map((fragment) => ({ ...fragment }));
}

export function getDemoMoments(): Moment[] {
  return [...demoCache.moments.values()];
}

export function getSampleDemoMoment(): Moment {
  const createdAt = new Date("2026-09-04T12:16:00Z");
  return {
    id: "demo-moment-cafeteria-example",
    groupId: group.id,
    title: "The cafeteria rush",
    summary: "A quick lunch turned into a little celebration when the cafeteria doors finally opened.",
    confidence: 0.82,
    uncertaintyLabel: "likely",
    uncertaintyReason: "Three nearby fragments from different people share the cafeteria as a place. It is a strong candidate, not a confirmed memory.",
    startAt: sampleFragments[0].capturedAt,
    endAt: sampleFragments[2].capturedAt,
    status: "candidate",
    evidence: [
      { fragmentId: sampleFragments[0].id, relationship: "entity_overlap" },
      { fragmentId: sampleFragments[1].id, relationship: "temporal" },
      { fragmentId: sampleFragments[2].id, relationship: "shared_location" },
    ],
    createdAt,
    updatedAt: createdAt,
  };
}