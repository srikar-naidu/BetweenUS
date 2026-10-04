import type {
  TemporalFragmentCandidate,
  TemporalFragmentQuery,
} from "@/lib/domain/memory";

export const MAX_CONTEXT_CANDIDATES = 12;

const stopWords = new Set([
  "about", "after", "again", "from", "have", "into", "just", "that", "their",
  "them", "then", "there", "these", "they", "this", "were", "what", "when",
  "where", "which", "with", "would",
]);

function tokens(value: string): Set<string> {
  return new Set(
    value.toLocaleLowerCase().split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !stopWords.has(token)),
  );
}

function normalizedValues(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map((value) => value.trim().toLocaleLowerCase()).filter(Boolean));
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function rankFragmentCandidates(
  query: TemporalFragmentQuery,
  candidates: readonly TemporalFragmentCandidate[],
): TemporalFragmentCandidate[] {
  const midpoint = (query.startAt.getTime() + query.endAt.getTime()) / 2;
  const halfWindowMs = Math.max(1, (query.endAt.getTime() - query.startAt.getTime()) / 2);
  const queryTokens = tokens(query.searchText ?? "");
  const queryEntities = normalizedValues(query.entityKeys);
  const knownMoments = normalizedValues(query.knownMomentIds);

  return candidates.map((candidate) => {
    const distance = Math.abs(candidate.capturedAt.getTime() - midpoint);
    const temporal = Math.max(0, 1 - distance / halfWindowMs);
    const lexical = overlapRatio(queryTokens, tokens(candidate.semanticSummary));
    const entity = overlapRatio(queryEntities, normalizedValues(candidate.entityKeys));
    const knownMoment = candidate.momentIds.some((id) => knownMoments.has(id)) ? 1 : 0;
    const retrievalScore = temporal * 15 + lexical * 25 + entity * 50 + knownMoment * 10;
    const matchedSignals: TemporalFragmentCandidate["matchedSignals"] = [];
    if (temporal > 0) matchedSignals.push("temporal");
    if (lexical > 0) matchedSignals.push("lexical");
    if (entity > 0) matchedSignals.push("entity_overlap");
    if (knownMoment) matchedSignals.push("known_moment");
    return { ...candidate, retrievalScore, matchedSignals };
  }).sort((left, right) =>
    right.retrievalScore - left.retrievalScore ||
    Math.abs(left.capturedAt.getTime() - midpoint) - Math.abs(right.capturedAt.getTime() - midpoint) ||
    left.fragmentId.localeCompare(right.fragmentId),
  ).slice(0, Math.max(1, Math.min(query.limit ?? 10, MAX_CONTEXT_CANDIDATES)));
}
