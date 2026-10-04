import type { MomentEvidence } from "../../src/lib/domain/memory";
import {
  deriveMomentUncertainty,
  validateMomentReconstructionOutput,
} from "../../src/lib/pipeline/moment-reconstruction";
import type {
  ContextPacketFragment,
  FragmentContextPacket,
} from "../../src/lib/pipeline/context-packet";
import { rankFragmentCandidates } from "../../src/lib/retrieval/ranking";
import { buildPhase9Dataset, phase9CaseCoverage, type Phase9Scenario } from "./dataset";

type SplitMetrics = {
  scenarioCount: number;
  pairCount: number;
  falseMergesAt1: number;
  missedSameEventPairsAt3: number;
};

export interface Phase9EvaluationReport {
  benchmark: "betweenus-phase9-synthetic-v1";
  syntheticOnly: true;
  fragments: number;
  groups: number;
  events: number;
  splitCounts: Record<"development" | "held_out", {
    fragments: number;
    groups: number;
    events: number;
  }>;
  caseCoverage: ReturnType<typeof phase9CaseCoverage>;
  retrieval: Record<"development" | "held_out" | "all", SplitMetrics>;
  acceptance: {
    validatedScenarios: number;
    validEvidenceIds: boolean;
    privateEvidenceRejected: number;
    privateEvidenceLeaks: number;
    crossGroupEvidenceRejected: number;
    crossGroupEvidenceLeaks: number;
    confirmedWithoutMemberAction: number;
    singleUploaderInsufficientEvidence: number;
    passed: boolean;
  };
  launchGate: "blocked_pilot_false_merge_threshold_not_set";
  limitations: string[];
}

function contextFragment(
  scenario: Phase9Scenario,
  fragmentId: string,
): ContextPacketFragment {
  const fragment = scenario.fragments.find((item) => item.id === fragmentId);
  if (!fragment) throw new Error("Synthetic context references a missing fragment");
  return {
    fragment_id: fragment.id,
    author_key: fragment.contributorKey,
    captured_at: fragment.capturedAt.toISOString(),
    summary: fragment.semanticSummary,
    entities: fragment.entityKeys,
    facts: [],
    review_required: false,
    retrieval_score: 1,
    matched_signals: ["synthetic-evaluation"],
    source_type: fragment.modality === "voice_transcript" ? "voice" : "text",
  };
}

function packetFor(
  scenario: Phase9Scenario,
  fragmentIds: readonly string[],
): FragmentContextPacket {
  const fragments = fragmentIds.map((fragmentId) => contextFragment(scenario, fragmentId));
  const times = fragments.map((fragment) => Date.parse(fragment.captured_at));
  return {
    version: "context-packet-v2",
    group_id: scenario.groupId,
    anchor_fragment_id: scenario.retrievalScenario.anchor.fragmentId,
    time_window: {
      start: new Date(Math.min(...times) - 20 * 60_000).toISOString(),
      end: new Date(Math.max(...times) + 20 * 60_000).toISOString(),
    },
    candidate_fragments: fragments,
    group_memories: [],
  };
}

function proposalFor(evidence: readonly MomentEvidence[]) {
  return {
    title: null,
    summary: "A synthetic proposal used only to exercise server validation.",
    confidence: 0.5,
    evidence: evidence.map((item) => ({
      fragment_id: item.fragmentId,
      relationship: item.relationship,
    })),
    contradictions: [],
    missing_evidence: [],
    uncertainty_notes: [],
    inference_notes: [],
  };
}

function assertProposalRejected(
  output: ReturnType<typeof proposalFor>,
  packet: FragmentContextPacket,
): boolean {
  try {
    validateMomentReconstructionOutput(output, packet);
  } catch (error) {
    if (error instanceof TypeError) return true;
    throw error;
  }
  return false;
}

function evaluateRetrieval(scenarios: readonly Phase9Scenario[]): SplitMetrics {
  let falseMergesAt1 = 0;
  let missedSameEventPairsAt3 = 0;
  let pairCount = 0;
  for (const scenario of scenarios) {
    pairCount += scenario.candidates.length;
    const anchor = scenario.retrievalScenario.anchor;
    const ranked = rankFragmentCandidates({
      groupId: scenario.groupId,
      startAt: new Date(anchor.capturedAt.getTime() - 30 * 60_000),
      endAt: new Date(anchor.capturedAt.getTime() + 30 * 60_000),
      searchText: anchor.searchText,
      entityKeys: anchor.entityKeys,
      limit: scenario.candidates.length,
    }, scenario.candidates);
    const labels = new Map(scenario.candidates.map((candidate) => [
      candidate.fragmentId,
      candidate.label,
    ]));
    if (labels.get(ranked[0]?.fragmentId ?? "") !== "same_event") falseMergesAt1 += 1;
    const topThreeIds = new Set(ranked.slice(0, 3).map((candidate) => candidate.fragmentId));
    missedSameEventPairsAt3 += scenario.candidates.filter((candidate) =>
      candidate.label === "same_event" && !topThreeIds.has(candidate.fragmentId),
    ).length;
  }
  return {
    scenarioCount: scenarios.length,
    pairCount,
    falseMergesAt1,
    missedSameEventPairsAt3,
  };
}

function runEvidenceAcceptance(scenarios: readonly Phase9Scenario[]) {
  let validatedScenarios = 0;
  let privateEvidenceRejected = 0;
  let privateEvidenceLeaks = 0;
  let crossGroupEvidenceRejected = 0;
  let crossGroupEvidenceLeaks = 0;
  let confirmedWithoutMemberAction = 0;
  let singleUploaderInsufficientEvidence = 0;

  for (const scenario of scenarios) {
    const anchorId = scenario.retrievalScenario.anchor.fragmentId;
    const positive = scenario.candidates.find((candidate) => candidate.label === "same_event");
    if (!positive) throw new Error("Synthetic evaluation scenario has no positive pair");
    const authorizedPacket = packetFor(scenario, [anchorId, positive.fragmentId]);
    const evidence: MomentEvidence[] = [
      { fragmentId: anchorId, relationship: "temporal" },
      { fragmentId: positive.fragmentId, relationship: "temporal" },
    ];
    validateMomentReconstructionOutput(proposalFor(evidence), authorizedPacket);
    validatedScenarios += 1;

    const privateFragment = scenario.fragments.find((fragment) =>
      fragment.visibility === "private",
    );
    if (privateFragment) {
      const rejected = assertProposalRejected(proposalFor([
        ...evidence,
        { fragmentId: privateFragment.id, relationship: "temporal" },
      ]), authorizedPacket);
      if (rejected) privateEvidenceRejected += 1;
      else privateEvidenceLeaks += 1;
    }
    const foreignFragment = scenarios.flatMap((other) => other.fragments)
      .find((fragment) => fragment.groupId !== scenario.groupId);
    if (!foreignFragment) throw new Error("Synthetic evaluation has no foreign-group fragment");
    const foreignRejected = assertProposalRejected(proposalFor([
      ...evidence,
      { fragmentId: foreignFragment.id, relationship: "temporal" },
    ]), authorizedPacket);
    if (foreignRejected) crossGroupEvidenceRejected += 1;
    else crossGroupEvidenceLeaks += 1;

    const uncertainty = deriveMomentUncertainty(authorizedPacket.candidate_fragments, evidence);
    if (uncertainty.label === "confirmed") confirmedWithoutMemberAction += 1;
    if (
      scenario.fragments.some((fragment) => fragment.cases.includes("single_uploader")) &&
      uncertainty.outcome === "insufficient_evidence"
    ) {
      singleUploaderInsufficientEvidence += 1;
    }
  }

  return {
    validatedScenarios,
    validEvidenceIds: validatedScenarios === scenarios.length,
    privateEvidenceRejected,
    privateEvidenceLeaks,
    crossGroupEvidenceRejected,
    crossGroupEvidenceLeaks,
    confirmedWithoutMemberAction,
    singleUploaderInsufficientEvidence,
    passed:
      validatedScenarios === scenarios.length &&
      privateEvidenceRejected === scenarios.length &&
      privateEvidenceLeaks === 0 &&
      crossGroupEvidenceRejected === scenarios.length &&
      crossGroupEvidenceLeaks === 0 &&
      singleUploaderInsufficientEvidence === 1 &&
      confirmedWithoutMemberAction === 0,
  };
}

export function evaluatePhase9(): Phase9EvaluationReport {
  const scenarios = buildPhase9Dataset();
  const fragments = scenarios.flatMap((scenario) => scenario.fragments);
  const events = new Set(
    fragments.flatMap((fragment) => fragment.eventId ? [fragment.eventId] : []),
  );
  const groupIds = new Set(scenarios.map((scenario) => scenario.groupId));
  const splitMetrics = (split: "development" | "held_out") => {
    const splitScenarios = scenarios.filter((scenario) => scenario.split === split);
    const splitFragments = splitScenarios.flatMap((scenario) => scenario.fragments);
    return {
      fragments: splitFragments.length,
      groups: new Set(splitScenarios.map((scenario) => scenario.groupId)).size,
      events: new Set(splitFragments.flatMap((fragment) =>
        fragment.eventId ? [fragment.eventId] : [],
      )).size,
    };
  };
  const splitCounts: Phase9EvaluationReport["splitCounts"] = {
    development: splitMetrics("development"),
    held_out: splitMetrics("held_out"),
  };
  const heldOutGroups = new Set(
    scenarios.filter((scenario) => scenario.split === "held_out")
      .map((scenario) => scenario.groupId),
  );
  const developmentGroups = new Set(
    scenarios.filter((scenario) => scenario.split === "development")
      .map((scenario) => scenario.groupId),
  );
  if ([...heldOutGroups].some((groupId) => developmentGroups.has(groupId))) {
    throw new Error("Synthetic evaluation group split is not disjoint");
  }

  return {
    benchmark: "betweenus-phase9-synthetic-v1",
    syntheticOnly: true,
    fragments: fragments.length,
    groups: groupIds.size,
    events: events.size,
    splitCounts,
    caseCoverage: phase9CaseCoverage(scenarios),
    retrieval: {
      development: evaluateRetrieval(scenarios.filter((scenario) => scenario.split === "development")),
      held_out: evaluateRetrieval(scenarios.filter((scenario) => scenario.split === "held_out")),
      all: evaluateRetrieval(scenarios),
    },
    acceptance: runEvidenceAcceptance(scenarios),
    launchGate: "blocked_pilot_false_merge_threshold_not_set",
    limitations: [
      "All 84 fragments are templated synthetic text or text-only modality labels; no participant media or real user data is present.",
      "Retrieval metrics measure ranking only; they do not evaluate Gemma output quality or predict real-world pilot error rates.",
      "Privacy checks exercise the server-side evidence validator with synthetic authorized packets, not deployed database access controls.",
      "Provider outages, account quotas, live queue recovery, deployment readiness, and user pilot outcomes require separate staging/operator verification.",
    ],
  };
}
