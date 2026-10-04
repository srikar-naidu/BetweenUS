import type { Fragment, MemberMoment, MemberStory, Moment, Story } from "@/lib/domain/memory";
import { fragmentSourceDigest } from "@/lib/ai/fragment-analysis";

export function momentForGroupMember(moment: Moment): MemberMoment {
  const { reviewHistory, ...visibleMoment } = moment;
  return {
    ...visibleMoment,
    canUndoCorrection: reviewHistory?.at(-1)?.action === "correct",
  };
}

export function visibleMomentsForMember(
  moments: readonly Moment[],
  fragments: readonly Fragment[],
): Moment[] {
  const eligibleFragmentIdsByGroup = new Map<string, Set<string>>();
  for (const fragment of fragments) {
    if (
      fragment.deletionState !== "active" ||
      fragment.visibility !== "group" ||
      !fragment.aiProcessingConsent
    ) {
      continue;
    }
    const eligibleFragmentIds = eligibleFragmentIdsByGroup.get(fragment.groupId) ?? new Set<string>();
    eligibleFragmentIds.add(fragment.id);
    eligibleFragmentIdsByGroup.set(fragment.groupId, eligibleFragmentIds);
  }

  return moments.filter((moment) => {
    if (
      (moment.status !== "candidate" && moment.status !== "confirmed") ||
      moment.evidence.length === 0
    ) {
      return false;
    }
    const eligibleFragmentIds = eligibleFragmentIdsByGroup.get(moment.groupId);
    return Boolean(
      eligibleFragmentIds &&
        moment.evidence.every((evidence) => eligibleFragmentIds.has(evidence.fragmentId)),
    );
  });
}

export function confirmedMomentsForEventStory(
  moments: readonly Moment[],
  fragments: readonly Fragment[],
): Moment[] {
  return visibleMomentsForMember(moments, fragments)
    .filter((moment) => moment.status === "confirmed");
}

export function visibleStoriesForMember(
  stories: readonly Story[],
  moments: readonly Moment[],
  fragments: readonly Fragment[],
): Story[] {
  const confirmedMomentRevisions = new Map(moments
    .filter((moment) => moment.status === "confirmed" && moment.evidence.length > 0)
    .filter((moment) => moment.evidence.every((evidence) =>
      fragments.some((fragment) =>
        fragment.id === evidence.fragmentId &&
        fragment.groupId === moment.groupId &&
        fragment.visibility === "group" &&
        fragment.aiProcessingConsent &&
        fragment.deletionState === "active",
      ),
    ))
    .map((moment) => [`${moment.groupId}\0${moment.id}`, moment.revision ?? 0]));
  const eligibleFragmentIds = new Set(fragments
    .filter((fragment) =>
      fragment.visibility === "group" &&
      fragment.aiProcessingConsent &&
      fragment.deletionState === "active",
    )
    .map((fragment) => `${fragment.groupId}\0${fragment.id}`));

  return stories.filter((story) =>
    story.momentIds.every((momentId) => confirmedMomentRevisions.has(`${story.groupId}\0${momentId}`)) &&
    (story.status === "candidate" || story.status === "confirmed") &&
    story.evidence.length >= 2 &&
    story.momentIds.length === story.evidence.length &&
    new Set(story.momentIds).size === story.momentIds.length &&
    story.evidence.every((evidence) =>
      confirmedMomentRevisions.get(`${story.groupId}\0${evidence.momentId}`) === evidence.momentRevision &&
      story.momentIds.includes(evidence.momentId) &&
      evidence.fragmentIds.length > 0 &&
      evidence.fragmentIds.every((fragmentId) =>
        eligibleFragmentIds.has(`${story.groupId}\0${fragmentId}`) &&
        evidence.fragmentSourceDigests.some((source) =>
          source.fragmentId === fragmentId &&
          fragments.some((fragment) =>
            fragment.id === fragmentId &&
            fragment.groupId === story.groupId &&
            fragmentSourceDigest(fragment) === source.sourceContentSha256,
          ),
        ),
      ),
    ),
  );
}

export function storyForGroupMember(story: Story): MemberStory {
  const {
    reviewHistory: _reviewHistory,
    sourceKey: _sourceKey,
    contextKey: _contextKey,
    modelVersion: _modelVersion,
    reconstructionVersion: _reconstructionVersion,
    evidence,
    ...visibleStory
  } = story;
  return {
    ...visibleStory,
    evidence: evidence.map(({ fragmentSourceDigests: _digests, ...item }) => item),
  };
}