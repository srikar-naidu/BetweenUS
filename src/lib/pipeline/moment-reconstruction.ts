import { randomUUID } from "node:crypto";
import type { Moment, MomentEvidence } from "@/lib/domain/memory";
import { OllamaGemmaProvider, type StructuredGenerationInput } from "@/lib/ai/gemma-provider";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import {
  buildFragmentContextPacket,
  type ContextPacketFragment,
  type FragmentContextPacket,
} from "@/lib/pipeline/context-packet";

export const MOMENT_RETRIEVAL_VERSION = "hybrid-context-v1";
export const MOMENT_RECONSTRUCTION_VERSION = "moment-reconstruction-v1";

export class MomentReconstructionError extends Error {
  constructor(
    public readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "MomentReconstructionError";
  }
}

export interface MomentReconstructionGenerator {
  readonly modelVersion: string;
  generateStructured(input: StructuredGenerationInput): Promise<Record<string, unknown>>;
}

export interface ValidatedMomentProposal {
  title: string | null;
  summary: string;
  confidence: number;
  evidence: MomentEvidence[];
  contradictions: Array<{ summary: string; evidence: Array<{ fragmentId: string; quote: string }> }>;
  missingEvidence: string[];
  uncertaintyNotes: string[];
  inferenceNotes: string[];
}

export interface MomentReconstructionResult {
  outcome: "candidate" | "insufficient_evidence";
  moment: Moment;
}

const relationships: readonly MomentEvidence["relationship"][] = [
  "temporal",
  "shared_people",
  "shared_location",
  "semantic_similarity",
  "entity_overlap",
];

function listSchema(maxItems: number, maxLength: number) {
  return {
    type: "array",
    maxItems,
    items: { type: "string", minLength: 1, maxLength },
  };
}

export function momentReconstructionResponseSchema(
  packet: FragmentContextPacket,
): Record<string, unknown> {
  const fragmentIds = packet.candidate_fragments.map((fragment) => fragment.fragment_id);
  return {
    type: "object",
    properties: {
      title: { type: ["string", "null"], maxLength: 120 },
      summary: { type: "string", minLength: 1, maxLength: 500 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidence: {
        type: "array",
        maxItems: fragmentIds.length,
        items: {
          type: "object",
          properties: {
            fragment_id: { type: "string", enum: fragmentIds },
            relationship: { type: "string", enum: relationships },
          },
          required: ["fragment_id", "relationship"],
          additionalProperties: false,
        },
      },
      contradictions: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            summary: { type: "string", minLength: 1, maxLength: 240 },
            evidence: {
              type: "array",
              minItems: 2,
              maxItems: fragmentIds.length,
              items: {
                type: "object",
                properties: {
                  fragment_id: { type: "string", enum: fragmentIds },
                  quote: { type: "string", minLength: 1, maxLength: 240 },
                },
                required: ["fragment_id", "quote"],
                additionalProperties: false,
              },
            },
          },
          required: ["summary", "evidence"],
          additionalProperties: false,
        },
      },
      missing_evidence: listSchema(8, 240),
      uncertainty_notes: listSchema(8, 240),
      inference_notes: listSchema(8, 240),
    },
    required: [
      "title",
      "summary",
      "confidence",
      "evidence",
      "contradictions",
      "missing_evidence",
      "uncertainty_notes",
      "inference_notes",
    ],
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

function boundedStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new TypeError(`Gemma returned invalid ${label}`);
  }
  return [...new Set(value.map((item) => boundedString(item, label, 240)))];
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function selectedPeers(
  fragment: ContextPacketFragment,
  evidence: readonly MomentEvidence[],
  fragmentsById: ReadonlyMap<string, ContextPacketFragment>,
): ContextPacketFragment[] {
  return evidence
    .filter((item) => item.fragmentId !== fragment.fragment_id)
    .map((item) => fragmentsById.get(item.fragmentId))
    .filter((peer): peer is ContextPacketFragment => Boolean(peer));
}

function relationshipIsSupported(
  item: MomentEvidence,
  fragment: ContextPacketFragment,
  evidence: readonly MomentEvidence[],
  fragmentsById: ReadonlyMap<string, ContextPacketFragment>,
): boolean {
  const peers = selectedPeers(fragment, evidence, fragmentsById);
  if (item.relationship === "temporal") {
    const timestamp = Date.parse(fragment.captured_at);
    return peers.some((peer) =>
      Math.abs(Date.parse(peer.captured_at) - timestamp) <= 20 * 60_000,
    );
  }

  if (item.relationship === "shared_people" || item.relationship === "shared_location") {
    const factType = item.relationship === "shared_people" ? "person" : "place";
    const values = new Set(
      fragment.facts
        .filter((fact) => fact.type === factType)
        .map((fact) => normalized(fact.value)),
    );
    return values.size > 0 && peers.some((peer) =>
      peer.facts.some((fact) => fact.type === factType && values.has(normalized(fact.value))),
    );
  }

  if (item.relationship === "entity_overlap") {
    const values = new Set([
      ...fragment.entities,
      ...fragment.facts.map((fact) => fact.value),
    ].map(normalized));
    return values.size > 0 && peers.some((peer) =>
      [...peer.entities, ...peer.facts.map((fact) => fact.value)]
        .some((value) => values.has(normalized(value))),
    );
  }

  const stopWords = new Set(["about", "after", "from", "into", "that", "the", "this", "with"]);
  const words = (value: string) => new Set(
    value.toLocaleLowerCase().split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !stopWords.has(word)),
  );
  const left = words(`${fragment.summary} ${fragment.entities.join(" ")}`);
  return peers.some((peer) => {
    const right = words(`${peer.summary} ${peer.entities.join(" ")}`);
    let common = 0;
    for (const word of left) if (right.has(word)) common += 1;
    return common >= 2;
  });
}

export function validateMomentReconstructionOutput(
  result: Record<string, unknown>,
  packet: FragmentContextPacket,
): ValidatedMomentProposal {
  const summary = boundedString(result.summary, "summary", 500);
  const title = result.title === null ? null : boundedString(result.title, "title", 120);
  if (
    typeof result.confidence !== "number" ||
    !Number.isFinite(result.confidence) ||
    result.confidence < 0 ||
    result.confidence > 1
  ) {
    throw new TypeError("Gemma returned an invalid confidence value");
  }
  if (!Array.isArray(result.evidence) || result.evidence.length > packet.candidate_fragments.length) {
    throw new TypeError("Gemma returned invalid moment evidence");
  }

  const fragmentsById = new Map(
    packet.candidate_fragments.map((fragment) => [fragment.fragment_id, fragment]),
  );
  const evidence = result.evidence.map((entry): MomentEvidence => {
    const value = objectValue(entry, "moment evidence");
    if (
      typeof value.fragment_id !== "string" ||
      !fragmentsById.has(value.fragment_id) ||
      typeof value.relationship !== "string" ||
      !relationships.includes(value.relationship as MomentEvidence["relationship"])
    ) {
      throw new TypeError("Gemma cited evidence outside the authorized context packet");
    }
    return {
      fragmentId: value.fragment_id,
      relationship: value.relationship as MomentEvidence["relationship"],
    };
  });
  if (new Set(evidence.map((item) => item.fragmentId)).size !== evidence.length) {
    throw new TypeError("Gemma returned duplicate fragment evidence");
  }
  for (const item of evidence) {
    const fragment = fragmentsById.get(item.fragmentId);
    if (!fragment || !relationshipIsSupported(item, fragment, evidence, fragmentsById)) {
      throw new TypeError(`Gemma assigned unsupported ${item.relationship} evidence to ${item.fragmentId}`);
    }
  }

  if (!Array.isArray(result.contradictions) || result.contradictions.length > 8) {
    throw new TypeError("Gemma returned invalid contradictions");
  }
  const contradictions = result.contradictions.map((entry) => {
    const value = objectValue(entry, "contradiction");
    const contradictionSummary = boundedString(value.summary, "contradiction summary", 240);
    if (!Array.isArray(value.evidence) || value.evidence.length < 2) {
      throw new TypeError("Gemma returned a contradiction without multiple sources");
    }
    const evidence = value.evidence.map((entry) => {
      const contradictionEvidence = objectValue(entry, "contradiction evidence");
      const fragmentId = contradictionEvidence.fragment_id;
      const quote = boundedString(contradictionEvidence.quote, "contradiction quote", 240);
      if (typeof fragmentId !== "string") {
        throw new TypeError("Gemma cited contradiction evidence outside the context packet");
      }
      const fragment = fragmentsById.get(fragmentId);
      if (!fragment) {
        throw new TypeError("Gemma cited contradiction evidence outside the context packet");
      }
      if (!fragment.facts.some((fact) => fact.evidence === quote)) {
        throw new TypeError("Gemma cited contradiction text that is not in the stored observations");
      }
      return { fragmentId, quote };
    });
    if (new Set(evidence.map((item) => item.fragmentId)).size < 2) {
      throw new TypeError("Gemma returned duplicate contradiction sources");
    }
    return { summary: contradictionSummary, evidence };
  });

  return {
    title,
    summary,
    confidence: result.confidence,
    evidence,
    contradictions,
    missingEvidence: boundedStringList(result.missing_evidence, "missing evidence"),
    uncertaintyNotes: boundedStringList(result.uncertainty_notes, "uncertainty notes"),
    inferenceNotes: boundedStringList(result.inference_notes, "inference notes"),
  };
}

export function deriveMomentUncertainty(
  fragments: ContextPacketFragment[],
  evidence: MomentEvidence[],
): { label: Moment["uncertaintyLabel"]; reason: string; outcome: MomentReconstructionResult["outcome"] } {
  const selected = fragments.filter((fragment) =>
    evidence.some((item) => item.fragmentId === fragment.fragment_id),
  );
  const authorCount = new Set(selected.map((fragment) => fragment.author_key)).size;
  if (selected.length < 2 || authorCount < 2) {
    return {
      label: "unknown",
      reason: "There is not enough independent, group-visible evidence to support a shared moment.",
      outcome: "insufficient_evidence",
    };
  }
  const times = selected.map((fragment) => Date.parse(fragment.captured_at));
  const span = Math.max(...times) - Math.min(...times);
  const corroborated = evidence.some((item) => item.relationship !== "temporal");
  if (selected.length >= 3 && authorCount >= 2 && corroborated && span <= 20 * 60_000) {
    return {
      label: "likely",
      reason: "Three or more fragments from multiple members share a validated corroborating detail within 20 minutes. This remains a candidate until a group member confirms it.",
      outcome: "candidate",
    };
  }
  return {
    label: "possible",
    reason: "Multiple members contributed nearby fragments, but the evidence does not meet the stronger corroboration rule. This is only a possibility, not a confirmed moment.",
    outcome: "candidate",
  };
}

export async function reconstructMoment(input: {
  groupId: string;
  anchorFragmentId: string;
  viewerUserId: string;
  momentId?: string;
  generator?: MomentReconstructionGenerator;
  database?: Awaited<ReturnType<typeof getMongoDatabase>>;
}): Promise<MomentReconstructionResult> {
  const database = input.database ?? await getMongoDatabase();
  const repository = new MongoMemoryRepository(database);
  const anchor = await repository.findFragmentVisibleToMember(
    input.groupId,
    input.anchorFragmentId,
    input.viewerUserId,
  );
  if (
    !anchor ||
    anchor.type !== "text" ||
    anchor.source !== "text" ||
    anchor.visibility !== "group" ||
    !anchor.aiProcessingConsent ||
    !anchor.textContent
  ) {
    throw new MomentReconstructionError(404, "Eligible anchor fragment not found");
  }
  const startAt = new Date(anchor.capturedAt.getTime() - 20 * 60_000);
  const endAt = new Date(anchor.capturedAt.getTime() + 20 * 60_000);
  const packet = await buildFragmentContextPacket({
    database,
    groupId: input.groupId,
    anchorFragmentId: anchor.id,
    startAt,
    endAt,
    viewerUserId: input.viewerUserId,
  });
  const generator = input.generator ?? new OllamaGemmaProvider();
  const distinctAuthors = new Set(packet.candidate_fragments.map((fragment) => fragment.author_key));
  let proposal: ValidatedMomentProposal | null = null;
  if (packet.candidate_fragments.length >= 2 && distinctAuthors.size >= 2) {
    const generated = await generator.generateStructured({
      task: "reconstruct_possible_moment",
      contextPacket: {
        ...packet,
        constraints: [
          "Return a candidate summary, not a confirmed fact.",
          "Cite only fragment IDs in candidate_fragments.",
          "Each evidence relationship must be directly supported by the supplied facts, entities, timestamps, or summaries.",
          "Use shared_people only for an exactly repeated literal person mention; do not infer that names refer to the same real person.",
          "Treat group_memories only as background context; they are not evidence for this event and must not be cited as fragment evidence.",
          "Every contradiction must cite exact evidence quotes present in the observations for each referenced fragment.",
          "List missing evidence and uncertainty notes rather than resolving ambiguous claims.",
          "Never set a certainty label. A deterministic validator and a group member control uncertainty and confirmation.",
        ],
      },
      responseSchema: momentReconstructionResponseSchema(packet),
    });
    proposal = validateMomentReconstructionOutput(generated, packet);
  }

  const evidence = proposal?.evidence ?? [];
  const uncertainty = deriveMomentUncertainty(packet.candidate_fragments, evidence);
  const selected = packet.candidate_fragments.filter((fragment) =>
    evidence.some((item) => item.fragmentId === fragment.fragment_id),
  );
  const contextIds = packet.candidate_fragments.map((fragment) => fragment.fragment_id);
  const currentSources = await repository.findEligibleGroupVisibleFragmentsByIds(input.groupId, contextIds);
  if (currentSources.length !== new Set(contextIds).size) {
    throw new MomentReconstructionError(409, "Moment evidence changed eligibility before it could be saved");
  }
  const selectedTimes = selected.map((fragment) => Date.parse(fragment.captured_at));
  const moment: Moment = {
    id: input.momentId ?? randomUUID(),
    groupId: input.groupId,
    title: proposal?.title ?? null,
    summary: proposal?.summary ?? "Not enough independent evidence to reconstruct a shared moment.",
    confidence: proposal?.confidence ?? 0,
    uncertaintyLabel: uncertainty.label,
    uncertaintyReason: uncertainty.reason,
    startAt: new Date(selectedTimes.length ? Math.min(...selectedTimes) : anchor.capturedAt.getTime()),
    endAt: new Date(selectedTimes.length ? Math.max(...selectedTimes) : anchor.capturedAt.getTime()),
    status: uncertainty.outcome === "candidate" ? "candidate" : "draft",
    evidence,
    reconstruction: {
      modelVersion: generator.modelVersion,
      retrievalVersion: MOMENT_RETRIEVAL_VERSION,
      validationOutcome: uncertainty.outcome === "candidate" ? "validated" : "insufficient_evidence",
      contradictions: proposal?.contradictions ?? [],
      missingEvidence: proposal?.missingEvidence ?? [],
      uncertaintyNotes: proposal?.uncertaintyNotes ?? [],
      inferenceNotes: proposal?.inferenceNotes ?? [],
    },
    reviewHistory: [],
    corrections: [],
    revision: 0,
    mergedIntoMomentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const saved = await repository.insertMomentIfAbsent(moment);
  return { outcome: uncertainty.outcome, moment: saved };
}
