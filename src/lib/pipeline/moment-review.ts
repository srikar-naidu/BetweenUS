import { randomUUID } from "node:crypto";
import type {
  Moment,
  MomentCorrectionType,
  MomentReviewEvent,
  MomentReviewSnapshot,
} from "@/lib/domain/memory";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";

export type MomentReviewAction =
  | { action: "confirm" }
  | { action: "reject" }
  | { action: "correct"; correctionType: MomentCorrectionType; fragmentId: string; value: string }
  | { action: "undo_correction" }
  | { action: "remove_evidence"; fragmentId: string }
  | { action: "merge"; targetMomentId: string };

export class MomentReviewError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = "MomentReviewError";
  }
}

function snapshot(moment: Moment): MomentReviewSnapshot {
  return {
    title: moment.title,
    summary: moment.summary,
    status: moment.status,
    uncertaintyLabel: moment.uncertaintyLabel,
    uncertaintyReason: moment.uncertaintyReason,
    evidence: moment.evidence.map((item) => ({ ...item })),
    corrections: (moment.corrections ?? []).map((item) => ({ ...item })),
    mergedIntoMomentId: moment.mergedIntoMomentId ?? null,
  };
}

function createEvent(input: {
  actorUserId: string;
  action: MomentReviewEvent["action"];
  before: MomentReviewSnapshot;
  after: MomentReviewSnapshot;
  details?: MomentReviewEvent["details"];
}): MomentReviewEvent {
  return {
    id: randomUUID(),
    actorUserId: input.actorUserId,
    action: input.action,
    occurredAt: new Date(),
    before: input.before,
    after: input.after,
    ...(input.details ? { details: input.details } : {}),
  };
}

async function requireEligibleEvidence(
  repository: MongoMemoryRepository,
  groupId: string,
  moment: Moment,
) {
  const fragmentIds = [...new Set(moment.evidence.map((item) => item.fragmentId))];
  const fragments = await repository.findEligibleGroupVisibleFragmentsByIds(groupId, fragmentIds);
  if (fragments.length !== fragmentIds.length) {
    throw new MomentReviewError(409, "Moment evidence is no longer eligible for group review");
  }
  return fragments;
}

async function persistReview(
  repository: MongoMemoryRepository,
  before: Moment,
  changes: Parameters<MongoMemoryRepository["reviewMoment"]>[0]["changes"],
  event: MomentReviewEvent,
): Promise<Moment> {
  const saved = await repository.reviewMoment({
    groupId: before.groupId,
    momentId: before.id,
    expectedUpdatedAt: before.updatedAt,
    expectedRevision: before.revision ?? 0,
    changes,
    event,
  });
  if (!saved) throw new MomentReviewError(409, "Moment changed; reload it and retry the review action");
  const updated = await repository.findMoment(before.groupId, before.id);
  if (!updated) throw new Error("Reviewed moment could not be read after saving");
  return updated;
}

export async function reviewMoment(input: {
  repository: MongoMemoryRepository;
  groupId: string;
  momentId: string;
  actorUserId: string;
  review: MomentReviewAction;
}): Promise<Moment> {
  const { repository, groupId, momentId, actorUserId, review } = input;
  const moment = await repository.findMoment(groupId, momentId);
  if (!moment || moment.status === "rejected" || moment.status === "merged") {
    throw new MomentReviewError(404, "Reviewable moment not found");
  }
  const eligibleFragments = await requireEligibleEvidence(repository, groupId, moment);
  const before = snapshot(moment);
  const timestamp = new Date();

  if (review.action === "confirm") {
    const authors = new Set(eligibleFragments.map((fragment) => fragment.authorUserId));
    if (
      moment.status !== "candidate" ||
      moment.reconstruction?.validationOutcome !== "validated" ||
      moment.evidence.length < 2 ||
      authors.size < 2
    ) {
      throw new MomentReviewError(422, "Only a corroborated candidate from multiple members can be confirmed");
    }
    const after = {
      ...before,
      status: "confirmed" as const,
      uncertaintyLabel: "confirmed" as const,
      uncertaintyReason: "A group member explicitly confirmed this moment.",
    };
    const event = createEvent({ actorUserId, action: "confirm", before, after });
    return persistReview(repository, moment, {
      status: after.status,
      uncertaintyLabel: after.uncertaintyLabel,
      uncertaintyReason: after.uncertaintyReason,
    }, event);
  }

  if (review.action === "reject") {
    const after = {
      ...before,
      status: "rejected" as const,
      uncertaintyLabel: "unknown" as const,
      uncertaintyReason: "A group member rejected this candidate moment.",
    };
    const event = createEvent({ actorUserId, action: "reject", before, after });
    return persistReview(repository, moment, {
      status: after.status,
      uncertaintyLabel: after.uncertaintyLabel,
      uncertaintyReason: after.uncertaintyReason,
    }, event);
  }

  if (review.action === "correct") {
    if (
      !moment.evidence.some((item) => item.fragmentId === review.fragmentId) ||
      !eligibleFragments.some((fragment) => fragment.id === review.fragmentId)
    ) {
      throw new MomentReviewError(422, "Corrections must refer to eligible evidence in this moment");
    }
    const correction = {
      id: randomUUID(),
      type: review.correctionType,
      fragmentId: review.fragmentId,
      value: review.value.trim(),
    };
    const corrections = [...(moment.corrections ?? []), correction];
    const after = { ...before, corrections };
    const event = createEvent({
      actorUserId,
      action: "correct",
      before,
      after,
      details: {
        correctionType: correction.type,
        fragmentId: correction.fragmentId,
        correctionId: correction.id,
        value: correction.value,
      },
    });
    return persistReview(repository, moment, { corrections }, event);
  }

  if (review.action === "undo_correction") {
    const lastEvent = moment.reviewHistory?.at(-1);
    if (!lastEvent || lastEvent.action !== "correct") {
      throw new MomentReviewError(409, "Only the latest correction can be undone");
    }
    const restored = lastEvent.before;
    const after = { ...restored };
    const event = createEvent({
      actorUserId,
      action: "undo_correction",
      before,
      after,
      details: { eventId: lastEvent.id },
    });
    return persistReview(repository, moment, {
      title: restored.title,
      summary: restored.summary,
      status: restored.status,
      uncertaintyLabel: restored.uncertaintyLabel,
      uncertaintyReason: restored.uncertaintyReason,
      evidence: restored.evidence,
      corrections: restored.corrections,
      mergedIntoMomentId: restored.mergedIntoMomentId,
    }, event);
  }

  if (review.action === "remove_evidence") {
    if (!moment.evidence.some((item) => item.fragmentId === review.fragmentId)) {
      throw new MomentReviewError(422, "The fragment is not evidence for this moment");
    }
    const evidence = moment.evidence.filter((item) => item.fragmentId !== review.fragmentId);
    const remainingFragments = eligibleFragments.filter((fragment) => fragment.id !== review.fragmentId);
    const sufficientlyCorroborated =
      evidence.length >= 2 &&
      new Set(remainingFragments.map((fragment) => fragment.authorUserId)).size >= 2;
    const after = {
      ...before,
      evidence,
      corrections: before.corrections.filter((correction) => correction.fragmentId !== review.fragmentId),
      status: sufficientlyCorroborated ? "candidate" as const : "draft" as const,
      uncertaintyLabel: sufficientlyCorroborated ? "possible" as const : "unknown" as const,
      uncertaintyReason: sufficientlyCorroborated
        ? "Evidence was removed by a group member; this candidate needs review."
        : "Evidence was removed and the remaining sources are insufficient to support a shared moment.",
    };
    const event = createEvent({
      actorUserId,
      action: "remove_evidence",
      before,
      after,
      details: { fragmentId: review.fragmentId },
    });
    return persistReview(repository, moment, {
      evidence: after.evidence,
      corrections: after.corrections,
      status: after.status,
      uncertaintyLabel: after.uncertaintyLabel,
      uncertaintyReason: after.uncertaintyReason,
    }, event);
  }

  const target = await repository.findMoment(groupId, review.targetMomentId);
  if (
    moment.status !== "candidate" ||
    !target ||
    (target.status !== "candidate" && target.status !== "confirmed") ||
    target.id === moment.id
  ) {
    throw new MomentReviewError(422, "Choose a different active candidate moment in this group to merge into");
  }
  const targetFragments = await requireEligibleEvidence(repository, groupId, target);
  const targetBefore = snapshot(target);
  const mergedEvidence = [...target.evidence];
  const knownEvidenceIds = new Set(mergedEvidence.map((item) => item.fragmentId));
  for (const item of moment.evidence) {
    if (!knownEvidenceIds.has(item.fragmentId)) mergedEvidence.push(item);
  }
  const mergedCorrections = [
    ...(target.corrections ?? []),
    ...(moment.corrections ?? []).filter((item) =>
      !target.corrections?.some((existing) =>
        existing.type === item.type &&
        existing.fragmentId === item.fragmentId &&
        existing.value === item.value,
      ),
    ),
  ];
  const allTargetFragments = [...targetFragments, ...eligibleFragments];
  const timestampById = new Map(allTargetFragments.map((fragment) => [fragment.id, fragment.capturedAt]));
  const sourceAfter = {
    ...before,
    status: "merged" as const,
    uncertaintyLabel: "unknown" as const,
    uncertaintyReason: `Merged into moment ${target.id} by a group member.`,
    mergedIntoMomentId: target.id,
  };
  const targetAfter = {
    ...targetBefore,
    evidence: mergedEvidence,
    corrections: mergedCorrections,
    status: "candidate" as const,
    uncertaintyLabel: "possible" as const,
    uncertaintyReason: "Evidence from another candidate was merged by a group member; review this updated candidate.",
  };
  const sourceEvent = createEvent({
    actorUserId,
    action: "merge",
    before,
    after: sourceAfter,
    details: { targetMomentId: target.id },
  });
  const targetEvent = createEvent({
    actorUserId,
    action: "merge",
    before: targetBefore,
    after: targetAfter,
    details: { targetMomentId: moment.id },
  });
  const evidenceTimes = mergedEvidence
    .map((item) => timestampById.get(item.fragmentId)?.getTime())
    .filter((value): value is number => value !== undefined);
  if (evidenceTimes.length !== new Set(mergedEvidence.map((item) => item.fragmentId)).size) {
    throw new MomentReviewError(409, "Merged moment evidence changed eligibility");
  }
  await repository.mergeMoments({
    groupId,
    sourceId: moment.id,
    targetId: target.id,
    sourceUpdatedAt: moment.updatedAt,
    targetUpdatedAt: target.updatedAt,
    sourceRevision: moment.revision ?? 0,
    targetRevision: target.revision ?? 0,
    sourceChanges: {
      status: sourceAfter.status,
      uncertaintyLabel: sourceAfter.uncertaintyLabel,
      uncertaintyReason: sourceAfter.uncertaintyReason,
      mergedIntoMomentId: sourceAfter.mergedIntoMomentId,
    },
    targetChanges: {
      evidence: mergedEvidence,
      corrections: mergedCorrections,
      status: targetAfter.status,
      uncertaintyLabel: targetAfter.uncertaintyLabel,
      uncertaintyReason: targetAfter.uncertaintyReason,
      startAt: new Date(Math.min(...evidenceTimes)),
      endAt: new Date(Math.max(...evidenceTimes)),
    },
    sourceEvent,
    targetEvent,
  });
  const updatedTarget = await repository.findMoment(groupId, target.id);
  if (!updatedTarget) throw new Error("Merged moment could not be read after saving");
  return updatedTarget;
}
