import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { momentForGroupMember } from "@/lib/auth/group-visibility";
import { getMongoDatabase } from "@/lib/db/mongodb";
import {
  MomentReviewError,
  reviewMoment,
  type MomentReviewAction,
} from "@/lib/pipeline/moment-review";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { MongoBackboardRepository } from "@/lib/repositories/mongodb-backboard-repository";
import {
  BackboardApiError,
  BackboardConfigurationError,
} from "@/lib/integrations/backboard-client";
import {
  deleteCorrectionMemory,
  GroupBackboardMemoryError,
} from "@/lib/pipeline/group-backboard-memory";

export const runtime = "nodejs";

function parseReviewAction(value: unknown): MomentReviewAction | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.action === "confirm" || input.action === "reject") {
    return { action: input.action };
  }
  if (input.action === "undo_correction") return { action: "undo_correction" };
  if (input.action === "remove_evidence" && typeof input.fragmentId === "string") {
    return { action: "remove_evidence", fragmentId: input.fragmentId };
  }
  if (
    input.action === "correct" &&
    (input.correctionType === "person" ||
      input.correctionType === "place" ||
      input.correctionType === "reference") &&
    typeof input.fragmentId === "string" &&
    typeof input.value === "string" &&
    input.value.trim().length > 0 &&
    input.value.length <= 240
  ) {
    return {
      action: "correct",
      correctionType: input.correctionType,
      fragmentId: input.fragmentId,
      value: input.value,
    };
  }
  if (input.action === "merge" && typeof input.targetMomentId === "string") {
    return { action: "merge", targetMomentId: input.targetMomentId };
  }
  return null;
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ groupId: string; momentId: string }> },
) {
  try {
    const { groupId, momentId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "A JSON body is required" }, { status: 400 });
    }
    const review = parseReviewAction(body);
    if (!review) return Response.json({ error: "Invalid moment review action" }, { status: 400 });
    const moment = await reviewMoment({
      repository: new MongoMemoryRepository(await getMongoDatabase()),
      groupId,
      momentId,
      actorUserId: session.user.id,
      review,
    });
    const backboardRepository = new MongoBackboardRepository(await getMongoDatabase());
    const allowedCorrectionIds = new Set(
      moment.status === "confirmed" ? moment.corrections?.map((item) => item.id) ?? [] : [],
    );
    let memoryCleanupPending = false;
    const affectedMoments = [...new Set([momentId, moment.id])];
    for (const affectedMomentId of affectedMoments) {
      const shared = await backboardRepository.findMemoryLinksForMoment(groupId, affectedMomentId);
      for (const link of shared) {
        if (allowedCorrectionIds.has(link.correctionId)) continue;
        try {
          await deleteCorrectionMemory({
            database: await getMongoDatabase(),
            groupId,
            correctionId: link.correctionId,
          });
        } catch (error) {
          if (
            !(error instanceof BackboardApiError) &&
            !(error instanceof BackboardConfigurationError) &&
            !(error instanceof GroupBackboardMemoryError)
          ) throw error;
          memoryCleanupPending = true;
          console.error("Backboard correction cleanup failed", error.name);
        }
      }
    }
    return Response.json(
      {
        moment: momentForGroupMember(moment),
        ...(memoryCleanupPending ? { memoryCleanupPending: true } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof MomentReviewError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return apiErrorResponse(error);
  }
}
