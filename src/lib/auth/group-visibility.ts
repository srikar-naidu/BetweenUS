import type { Fragment, MemberMoment, Moment } from "@/lib/domain/memory";

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