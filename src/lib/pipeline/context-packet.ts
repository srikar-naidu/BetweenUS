import type { Db } from "mongodb";
import { createHash } from "node:crypto";
import { FRAGMENT_ANALYSIS_VERSION } from "@/lib/ai/fragment-analysis";
import { fragmentAnalysisSearchText } from "@/lib/ai/fragment-analysis";
import { MongoFragmentAnalysisRepository } from "@/lib/repositories/mongodb-fragment-analysis-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MAX_CONTEXT_CANDIDATES } from "@/lib/retrieval/ranking";
import { TigerDataFragmentSearch } from "@/lib/retrieval/tiger-data";
import { searchConfirmedGroupMemories } from "@/lib/pipeline/group-backboard-memory";

export interface ContextPacketFragment {
  fragment_id: string;
  author_key: string;
  captured_at: string;
  summary: string;
  entities: string[];
  facts: Array<{ type: string; value: string; evidence: string }>;
  retrieval_score: number;
  matched_signals: string[];
}

export interface FragmentContextPacket {
  version: "context-packet-v1";
  group_id: string;
  anchor_fragment_id: string;
  time_window: { start: string; end: string };
  candidate_fragments: ContextPacketFragment[];
  group_memories: Array<{
    memory_id: string;
    moment_id: string;
    correction_type: string;
    content: string;
  }>;
}

export async function buildFragmentContextPacket(input: {
  database: Db;
  groupId: string;
  anchorFragmentId: string;
  startAt: Date;
  endAt: Date;
  viewerUserId: string;
  retrieval?: TigerDataFragmentSearch;
}): Promise<FragmentContextPacket> {
  if (
    !Number.isFinite(input.startAt.getTime()) ||
    !Number.isFinite(input.endAt.getTime()) ||
    input.startAt > input.endAt
  ) {
    throw new TypeError("Context packet time window is invalid");
  }
  const memory = new MongoMemoryRepository(input.database);
  const anchor = await memory.findFragmentVisibleToMember(
    input.groupId,
    input.anchorFragmentId,
    input.viewerUserId,
  );
  if (
    !anchor ||
    anchor.deletionState !== "active" ||
    anchor.type !== "text" ||
    anchor.source !== "text" ||
    anchor.visibility !== "group" ||
    !anchor.aiProcessingConsent ||
    !anchor.textContent
  ) {
    throw new Error("Anchor fragment is not eligible for group reconstruction");
  }
  if (anchor.capturedAt < input.startAt || anchor.capturedAt > input.endAt) {
    throw new Error("Anchor fragment is outside the requested time window");
  }
  const analyses = new MongoFragmentAnalysisRepository(input.database);
  const anchorAnalysis = await analyses.find(input.groupId, anchor.id, FRAGMENT_ANALYSIS_VERSION);
  if (!anchorAnalysis) throw new Error("Anchor fragment has no current analysis");
  const anchorChecksum = createHash("sha256").update(anchor.textContent).digest("hex");
  if (anchorAnalysis.sourceTextSha256 !== anchorChecksum) {
    throw new Error("Anchor fragment analysis is stale");
  }
  const knownMomentIds = await memory.findLinkedMomentIds(input.groupId, anchor.id);
  const retrieval = input.retrieval ?? new TigerDataFragmentSearch();
  const candidates = await retrieval.findCandidates({
    groupId: input.groupId,
    startAt: input.startAt,
    endAt: input.endAt,
    excludeFragmentId: anchor.id,
    searchText: fragmentAnalysisSearchText(anchorAnalysis),
    entityKeys: anchorAnalysis.entities,
    knownMomentIds,
    limit: MAX_CONTEXT_CANDIDATES - 1,
  });
  const candidateIds = candidates.map((candidate) => candidate.fragmentId);
  const eligibleFragments = await memory.findGroupVisibleFragments(
    input.groupId,
    input.startAt,
    input.endAt,
    100,
  );
  const eligibleById = new Map(
    eligibleFragments
      .filter((fragment) => fragment.id !== anchor.id)
      .map((fragment) => [fragment.id, fragment]),
  );
  const candidateAnalyses = await analyses.findMany(
    input.groupId,
    candidateIds,
    FRAGMENT_ANALYSIS_VERSION,
  );
  const analysesById = new Map(candidateAnalyses.map((analysis) => [analysis.fragmentId, analysis]));

  const toContextFragment = (
    fragment: typeof anchor,
    analysis: typeof anchorAnalysis,
    retrievalScore: number,
    matchedSignals: string[],
  ): ContextPacketFragment => ({
    fragment_id: fragment.id,
    author_key: createHash("sha256")
      .update(`${input.groupId}\0${fragment.authorUserId}`)
      .digest("hex")
      .slice(0, 16),
    captured_at: fragment.capturedAt.toISOString(),
    summary: analysis.summary.slice(0, 500),
    entities: analysis.entities.slice(0, 20),
    facts: analysis.observedFacts.slice(0, 8).map(({ type, value, evidence }) => ({
      type,
      value: value.slice(0, 240),
      evidence: evidence.slice(0, 240),
    })),
    retrieval_score: retrievalScore,
    matched_signals: matchedSignals,
  });

  const candidateFragments = [
    toContextFragment(anchor, anchorAnalysis, 0, ["anchor"]),
    ...candidates.flatMap((candidate) => {
      const fragment = eligibleById.get(candidate.fragmentId);
      const analysis = analysesById.get(candidate.fragmentId);
      if (
        !fragment ||
        !analysis ||
        fragment.type !== "text" ||
        fragment.source !== "text" ||
        !fragment.textContent
      ) return [];
      const sourceChecksum = createHash("sha256").update(fragment.textContent).digest("hex");
      if (analysis.sourceTextSha256 !== sourceChecksum) return [];
      return [toContextFragment(fragment, analysis, candidate.retrievalScore, candidate.matchedSignals)];
    }),
  ].slice(0, MAX_CONTEXT_CANDIDATES);
  const groupMemories = await searchConfirmedGroupMemories({
    database: input.database,
    groupId: input.groupId,
    query: [anchorAnalysis.summary, ...anchorAnalysis.entities.slice(0, 8)].join(" ").slice(0, 500),
    limit: 3,
  });

  return {
    version: "context-packet-v1",
    group_id: input.groupId,
    anchor_fragment_id: anchor.id,
    time_window: {
      start: input.startAt.toISOString(),
      end: input.endAt.toISOString(),
    },
    candidate_fragments: candidateFragments,
    group_memories: groupMemories.map((memory) => ({
      memory_id: memory.memoryId,
      moment_id: memory.momentId,
      correction_type: memory.correctionType,
      content: memory.content,
    })),
  };
}
