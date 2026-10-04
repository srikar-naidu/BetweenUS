import type { TemporalFragmentCandidate } from "../../src/lib/domain/memory";
import { rankFragmentCandidates } from "../../src/lib/retrieval/ranking";

export type EvaluationSplit = "development" | "held_out";
export type PairLabel = "same_event" | "different_event" | "insufficient_evidence";
export type EvidenceSource = "text" | "voice_transcript";

export interface SyntheticCandidate extends TemporalFragmentCandidate {
  label: PairLabel;
  source: EvidenceSource;
}

export interface SyntheticScenario {
  id: string;
  split: EvaluationSplit;
  anchor: {
    fragmentId: string;
    capturedAt: Date;
    searchText: string;
    entityKeys: string[];
  };
  candidates: SyntheticCandidate[];
}

interface ScenarioSeed {
  id: string;
  split: EvaluationSplit;
  anchorText: string;
  entities: [string, string, string];
  paraphrase: string;
  alternateParaphrase: string;
  lexicalDistractor: string;
  samePlaceDistractor: string;
  insufficient: string;
}

const seeds: readonly ScenarioSeed[] = [
  {
    id: "cafeteria-after-rehearsal",
    split: "development",
    anchorText: "After rehearsal we met at the campus cafeteria for dumplings and tea.",
    entities: ["campus cafeteria", "dumplings", "rehearsal"],
    paraphrase: "The cast grabbed dumplings in the cafeteria when practice ended.",
    alternateParaphrase: "Tea and dumplings together after the rehearsal.",
    lexicalDistractor: "The cafeteria menu listed dumplings and tea after rehearsal.",
    samePlaceDistractor: "Another lunch at the campus cafeteria, unrelated to rehearsal.",
    insufficient: "Maybe this happened around lunchtime; I cannot remember more.",
  },
  {
    id: "river-trail-kite",
    split: "development",
    anchorText: "We tested the blue kite beside the north river trail before sunset.",
    entities: ["north river trail", "blue kite", "sunset"],
    paraphrase: "The kite finally flew along the river path as evening came.",
    alternateParaphrase: "A windy sunset walk by the north trail with our kite.",
    lexicalDistractor: "A shop advertised blue kites and river trail maps at sunset.",
    samePlaceDistractor: "A different evening walk by the north river trail without the kite test.",
    insufficient: "There was something outdoors near the water, perhaps.",
  },
  {
    id: "rooftop-potluck",
    split: "development",
    anchorText: "Our apartment floor shared a rooftop potluck with mango rice.",
    entities: ["apartment rooftop", "mango rice", "potluck"],
    paraphrase: "Neighbors brought mango rice up to the roof for dinner together.",
    alternateParaphrase: "The rooftop dinner turned into a shared potluck.",
    lexicalDistractor: "A rooftop restaurant menu featured mango rice and potluck specials.",
    samePlaceDistractor: "A separate rooftop gathering another weekend, not the potluck.",
    insufficient: "I remember a meal with neighbors, but no clear details.",
  },
  {
    id: "library-robotics",
    split: "development",
    anchorText: "Robotics club repaired the rover at the east library table after class.",
    entities: ["east library", "robotics club", "rover"],
    paraphrase: "The club got the little robot moving again in the library.",
    alternateParaphrase: "After class we fixed the rover together at the east branch.",
    lexicalDistractor: "The library posted a robotics book display beside a rover photo.",
    samePlaceDistractor: "A different library study session with no robotics repair.",
    insufficient: "Someone mentioned a project after class, details are missing.",
  },
  {
    id: "community-garden-harvest",
    split: "development",
    anchorText: "We picked the first tomatoes together in the community garden.",
    entities: ["community garden", "first tomatoes", "harvest"],
    paraphrase: "The garden crew harvested ripe tomatoes for the first time.",
    alternateParaphrase: "Our first tomato picking at the shared garden beds.",
    lexicalDistractor: "A garden flyer advertised tomatoes and a harvest festival.",
    samePlaceDistractor: "A later watering visit to the community garden, not harvest day.",
    insufficient: "There may have been vegetables, but I am unsure.",
  },
  {
    id: "station-jazz-set",
    split: "development",
    anchorText: "We caught the brass quartet's short jazz set at Union Station.",
    entities: ["union station", "brass quartet", "jazz set"],
    paraphrase: "The quartet played jazz for us while we waited at the station.",
    alternateParaphrase: "A quick brass performance at Union Station before the train.",
    lexicalDistractor: "Union Station's poster promoted a brass jazz set next month.",
    samePlaceDistractor: "A separate train wait at Union Station with no music.",
    insufficient: "There was music somewhere near a trip, maybe.",
  },
  {
    id: "science-museum-shadow",
    split: "development",
    anchorText: "At the science museum we made shadow shapes in the prism room.",
    entities: ["science museum", "prism room", "shadow shapes"],
    paraphrase: "We played with silhouettes in the museum's light exhibit.",
    alternateParaphrase: "The prism gallery made our hand shadows look enormous.",
    lexicalDistractor: "The museum shop sold a science book about prisms and shadows.",
    samePlaceDistractor: "Another visit to the science museum, this time in the space hall.",
    insufficient: "I remember a museum visit, but not which activity.",
  },
  {
    id: "orchard-apple-crates",
    split: "development",
    anchorText: "We filled two apple crates at the hillside orchard before rain.",
    entities: ["hillside orchard", "apple crates", "rain"],
    paraphrase: "The orchard trip ended with two boxes of apples and a storm.",
    alternateParaphrase: "We picked apples on the hill just before the rain began.",
    lexicalDistractor: "An orchard notice mentioned apple crates and rain gear.",
    samePlaceDistractor: "A different orchard visit to prune trees, not pick apples.",
    insufficient: "There was a farm trip, perhaps in bad weather.",
  },
  {
    id: "makerspace-lantern",
    split: "held_out",
    anchorText: "At the makerspace we built paper lanterns for the winter walk.",
    entities: ["makerspace", "paper lanterns", "winter walk"],
    paraphrase: "Our group crafted lanterns before the neighborhood evening walk.",
    alternateParaphrase: "Paper lights were ready for the winter walk after workshop.",
    lexicalDistractor: "The makerspace calendar listed paper lanterns and a winter walk.",
    samePlaceDistractor: "A separate makerspace repair night, unrelated to the lanterns.",
    insufficient: "We did a craft together; the event is unclear.",
  },
  {
    id: "harbor-tide-pools",
    split: "held_out",
    anchorText: "We sketched tiny crabs at the south harbor tide pools.",
    entities: ["south harbor", "tide pools", "tiny crabs"],
    paraphrase: "At low tide we drew the little crabs by the harbor rocks.",
    alternateParaphrase: "The south harbor pools were full of crabs to sketch.",
    lexicalDistractor: "A harbor guide described crabs and tide pools for visitors.",
    samePlaceDistractor: "A later harbor walk to watch boats, not explore tide pools.",
    insufficient: "We looked at small sea creatures somewhere.",
  },
  {
    id: "school-courtyard-chess",
    split: "held_out",
    anchorText: "We played giant chess in the school courtyard during lunch.",
    entities: ["school courtyard", "giant chess", "lunch"],
    paraphrase: "Lunch break turned into a chess match with the oversized pieces.",
    alternateParaphrase: "The big chess set came out in the courtyard at noon.",
    lexicalDistractor: "The school bulletin advertised courtyard chess at lunch next week.",
    samePlaceDistractor: "A different lunch in the courtyard, with no chess game.",
    insufficient: "Something happened at school around midday.",
  },
  {
    id: "hilltop-observatory",
    split: "held_out",
    anchorText: "We watched Saturn through the west hill observatory telescope.",
    entities: ["west hill observatory", "Saturn", "telescope"],
    paraphrase: "The telescope at the hill observatory showed us Saturn's rings.",
    alternateParaphrase: "We saw Saturn together during the observatory night.",
    lexicalDistractor: "An observatory lecture covered Saturn and telescope design.",
    samePlaceDistractor: "Another observatory night focused on the moon, not Saturn.",
    insufficient: "We looked at stars from a hill, details uncertain.",
  },
];

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function sourceFor(index: number): EvidenceSource {
  return index % 3 === 0 ? "voice_transcript" : "text";
}

export function buildSyntheticBenchmark(): SyntheticScenario[] {
  const start = new Date("2026-01-10T12:00:00.000Z");
  return seeds.map((seed, scenarioIndex) => {
    const capturedAt = addMinutes(start, scenarioIndex * 24 * 60);
    const anchorId = `synthetic-${seed.id}-anchor`;
    const candidate = (
      suffix: string,
      minutes: number,
      semanticSummary: string,
      entityKeys: string[],
      label: PairLabel,
      index: number,
    ): SyntheticCandidate => ({
      fragmentId: `synthetic-${seed.id}-${suffix}`,
      capturedAt: addMinutes(capturedAt, minutes),
      semanticSummary,
      entityKeys,
      momentIds: [],
      retrievalScore: 0,
      matchedSignals: [],
      label,
      source: sourceFor(index),
    });

    return {
      id: seed.id,
      split: seed.split,
      anchor: {
        fragmentId: anchorId,
        capturedAt,
        searchText: seed.anchorText,
        entityKeys: [...seed.entities],
      },
      candidates: [
        candidate("positive-paraphrase", 8, seed.paraphrase, [...seed.entities], "same_event", 0),
        candidate("positive-alternate", 17, seed.alternateParaphrase, [...seed.entities], "same_event", 1),
        candidate("lexical-distractor", 1, seed.lexicalDistractor, ["unrelated notice"], "different_event", 2),
        candidate(
          "same-place-distractor",
          25,
          `A separate event was described this way: ${seed.anchorText} ${seed.samePlaceDistractor}`,
          [...seed.entities],
          "different_event",
          3,
        ),
        candidate("insufficient", 3, seed.insufficient, [], "insufficient_evidence", 4),
      ],
    };
  });
}

export interface RankingMetrics {
  scenarioCount: number;
  pairCount: number;
  precisionAt1: number;
  recallAt1: number;
  recallAt3: number;
  meanReciprocalRank: number;
  nonPositiveTop1Rate: number;
}

export interface BenchmarkSummary {
  benchmark: "betweenus-phase7-synthetic-v1";
  syntheticOnly: true;
  split: EvaluationSplit | "all";
  scenarioCount: number;
  pairCount: number;
  labelCounts: Record<PairLabel, number>;
  modalities: Record<EvidenceSource, number>;
  metrics: {
    lexicalTime: RankingMetrics;
    productionHybrid: RankingMetrics;
  };
}

function lexicalTimeRank(scenario: SyntheticScenario): SyntheticCandidate[] {
  const terms = scenario.anchor.searchText.toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return [...scenario.candidates].sort((left, right) => {
    const score = (candidate: SyntheticCandidate) => {
      const text = candidate.semanticSummary.toLocaleLowerCase();
      const lexicalMatches = new Set(terms.filter((term) => term.length > 2 && text.includes(term))).size;
      const minutes = Math.abs(candidate.capturedAt.getTime() - scenario.anchor.capturedAt.getTime()) / 60_000;
      return lexicalMatches * 10 - minutes;
    };
    return score(right) - score(left) || left.fragmentId.localeCompare(right.fragmentId);
  });
}

function productionHybridRank(scenario: SyntheticScenario): SyntheticCandidate[] {
  const windowMinutes = 30;
  const candidatesById = new Map(
    scenario.candidates.map((candidate) => [candidate.fragmentId, candidate]),
  );
  return rankFragmentCandidates({
    groupId: "synthetic-phase7",
    startAt: addMinutes(scenario.anchor.capturedAt, -windowMinutes),
    endAt: addMinutes(scenario.anchor.capturedAt, windowMinutes),
    searchText: scenario.anchor.searchText,
    entityKeys: scenario.anchor.entityKeys,
    limit: scenario.candidates.length,
  }, scenario.candidates).flatMap((candidate) => {
    const source = candidatesById.get(candidate.fragmentId);
    return source ? [source] : [];
  });
}

function metricsFor(
  scenarios: readonly SyntheticScenario[],
  rank: (scenario: SyntheticScenario) => SyntheticCandidate[],
): RankingMetrics {
  let relevantAt1 = 0;
  let relevantRetrievedAt1 = 0;
  let relevantRetrievedAt3 = 0;
  let totalRelevant = 0;
  let reciprocalRankTotal = 0;
  for (const scenario of scenarios) {
    const ranked = rank(scenario);
    totalRelevant += scenario.candidates.filter((candidate) => candidate.label === "same_event").length;
    const firstRelevant = ranked.findIndex((candidate) => candidate.label === "same_event");
    if (firstRelevant === 0) {
      relevantAt1 += 1;
      relevantRetrievedAt1 += 1;
    }
    relevantRetrievedAt3 += ranked.slice(0, 3)
      .filter((candidate) => candidate.label === "same_event").length;
    if (firstRelevant >= 0) reciprocalRankTotal += 1 / (firstRelevant + 1);
  }
  const count = scenarios.length;
  const precisionAt1 = count === 0 ? 0 : relevantAt1 / count;
  return {
    scenarioCount: count,
    pairCount: scenarios.reduce((total, scenario) => total + scenario.candidates.length, 0),
    precisionAt1,
    recallAt1: totalRelevant === 0 ? 0 : relevantRetrievedAt1 / totalRelevant,
    recallAt3: totalRelevant === 0 ? 0 : relevantRetrievedAt3 / totalRelevant,
    meanReciprocalRank: count === 0 ? 0 : reciprocalRankTotal / count,
    nonPositiveTop1Rate: count === 0 ? 0 : 1 - precisionAt1,
  };
}

export function evaluateSyntheticBenchmark(
  split: EvaluationSplit | "all" = "all",
): BenchmarkSummary {
  const scenarios = buildSyntheticBenchmark().filter((scenario) =>
    split === "all" || scenario.split === split,
  );
  const labelCounts: Record<PairLabel, number> = {
    same_event: 0,
    different_event: 0,
    insufficient_evidence: 0,
  };
  const modalities: Record<EvidenceSource, number> = { text: 0, voice_transcript: 0 };
  for (const scenario of scenarios) {
    for (const candidate of scenario.candidates) {
      labelCounts[candidate.label] += 1;
      modalities[candidate.source] += 1;
    }
  }
  return {
    benchmark: "betweenus-phase7-synthetic-v1",
    syntheticOnly: true,
    split,
    scenarioCount: scenarios.length,
    pairCount: scenarios.reduce((total, scenario) => total + scenario.candidates.length, 0),
    labelCounts,
    modalities,
    metrics: {
      lexicalTime: metricsFor(scenarios, lexicalTimeRank),
      productionHybrid: metricsFor(scenarios, productionHybridRank),
    },
  };
}
