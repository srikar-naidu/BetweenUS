import {
  buildSyntheticBenchmark,
  type EvaluationSplit,
  type PairLabel,
  type SyntheticCandidate,
  type SyntheticScenario,
} from "../phase7/benchmark";

export type Phase9Case =
  | "same_place_different_event"
  | "same_people_different_event"
  | "misleading_text"
  | "single_uploader"
  | "mixed_media"
  | "insufficient_evidence";

export type Phase9Modality = "text" | "voice_transcript" | "image_caption";

export interface Phase9Fragment {
  id: string;
  groupId: string;
  eventId: string | null;
  split: EvaluationSplit;
  contributorKey: string;
  participantKeys: string[];
  capturedAt: Date;
  visibility: "group" | "private";
  modality: Phase9Modality;
  label: PairLabel | "anchor";
  semanticSummary: string;
  entityKeys: string[];
  cases: Phase9Case[];
}

export interface Phase9Scenario {
  id: string;
  groupId: string;
  split: EvaluationSplit;
  retrievalScenario: SyntheticScenario;
  candidates: SyntheticCandidate[];
  fragments: Phase9Fragment[];
}

function samePeopleCandidate(scenario: SyntheticScenario): SyntheticCandidate {
  return {
    fragmentId: `synthetic-${scenario.id}-same-people-different-event`,
    capturedAt: new Date(scenario.anchor.capturedAt.getTime() + 20 * 60_000),
    semanticSummary: "The same two friends met again for a separate activity.",
    entityKeys: ["same attendees", "separate activity"],
    momentIds: [],
    retrievalScore: 0,
    matchedSignals: [],
    label: "different_event",
    source: "text",
  };
}

function eventIdForCandidate(
  scenario: SyntheticScenario,
  candidate: SyntheticCandidate,
): string | null {
  if (candidate.label === "insufficient_evidence") return null;
  if (candidate.label === "same_event") return scenario.id;
  return `${scenario.id}-near-neighbor`;
}

function fragmentCases(
  scenarioId: string,
  candidate: SyntheticCandidate | null,
): Phase9Case[] {
  if (!candidate) return [];
  const cases: Phase9Case[] = [];
  if (candidate.fragmentId.includes("same-place-distractor")) {
    cases.push("same_place_different_event");
  }
  if (candidate.fragmentId.includes("same-people-different-event")) {
    cases.push("same_people_different_event");
  }
  if (candidate.fragmentId.includes("lexical-distractor")) cases.push("misleading_text");
  if (scenarioId === "cafeteria-after-rehearsal") cases.push("single_uploader");
  if (
    scenarioId === "makerspace-lantern" &&
    (candidate.source === "voice_transcript" || candidate.label === "same_event")
  ) {
    cases.push("mixed_media");
  }
  if (candidate.label === "insufficient_evidence") cases.push("insufficient_evidence");
  return cases;
}

function modalityFor(
  scenarioId: string,
  candidate: SyntheticCandidate | null,
): Phase9Modality {
  if (scenarioId === "makerspace-lantern" && candidate?.label === "same_event") {
    return "image_caption";
  }
  return candidate?.source ?? "text";
}

export function buildPhase9Dataset(): Phase9Scenario[] {
  return buildSyntheticBenchmark().map((retrievalScenario) => {
    const groupId = `phase9-${retrievalScenario.split}-${retrievalScenario.id}`;
    const candidates = [
      ...retrievalScenario.candidates,
      samePeopleCandidate(retrievalScenario),
    ];
    const candidateFragments = candidates.map((candidate, index): Phase9Fragment => {
      const cases = fragmentCases(retrievalScenario.id, candidate);
      const isSingleUploader = retrievalScenario.id === "cafeteria-after-rehearsal";
      return {
        id: candidate.fragmentId,
        groupId,
        eventId: eventIdForCandidate(retrievalScenario, candidate),
        split: retrievalScenario.split,
        contributorKey: isSingleUploader ? "member-one" : `member-${(index % 3) + 1}`,
        participantKeys: candidate.fragmentId.includes("same-people-different-event")
          ? ["participant-one", "participant-two"]
          : [`participant-${(index % 3) + 1}`],
        capturedAt: candidate.capturedAt,
        visibility: candidate.label === "insufficient_evidence" ? "private" : "group",
        modality: modalityFor(retrievalScenario.id, candidate),
        label: candidate.label,
        semanticSummary: candidate.semanticSummary,
        entityKeys: candidate.entityKeys,
        cases,
      };
    });
    const anchor: Phase9Fragment = {
      id: retrievalScenario.anchor.fragmentId,
      groupId,
      eventId: retrievalScenario.id,
      split: retrievalScenario.split,
      contributorKey: "member-one",
      participantKeys: ["participant-one", "participant-two"],
      capturedAt: retrievalScenario.anchor.capturedAt,
      visibility: "group",
      modality: "text",
      label: "anchor",
      semanticSummary: retrievalScenario.anchor.searchText,
      entityKeys: retrievalScenario.anchor.entityKeys,
      cases: [],
    };
    return {
      id: retrievalScenario.id,
      groupId,
      split: retrievalScenario.split,
      retrievalScenario,
      candidates,
      fragments: [anchor, ...candidateFragments],
    };
  });
}

export function phase9CaseCoverage(
  scenarios: readonly Phase9Scenario[],
): Record<Phase9Case, number> {
  const coverage: Record<Phase9Case, number> = {
    same_place_different_event: 0,
    same_people_different_event: 0,
    misleading_text: 0,
    single_uploader: 0,
    mixed_media: 0,
    insufficient_evidence: 0,
  };
  for (const scenario of scenarios) {
    for (const fragment of scenario.fragments) {
      for (const caseName of fragment.cases) coverage[caseName] += 1;
    }
  }
  return coverage;
}
