import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { getTemporalClient, getTemporalSettings, startFragmentWorkflow, TemporalConfigurationError } from "@/lib/processing/temporal-client";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { TigerDataFragmentSearch } from "@/lib/retrieval/tiger-data";
import { isPrivateObjectStorageConfigured, ObjectStorageConfigurationError } from "@/lib/storage/r2-object-store";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ groupId: string; fragmentId: string }> },
) {
  try {
    const { groupId, fragmentId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "A JSON body is required" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ error: "Invalid fragment privacy settings" }, { status: 400 });
    }

    const input = body as Record<string, unknown>;
    const validVisibility = ["private", "group", "restricted"].includes(String(input.visibility));
    if (!validVisibility || typeof input.aiProcessingConsent !== "boolean") {
      return Response.json({ error: "Visibility and AI consent must be explicit" }, { status: 400 });
    }

    const repository = new MongoMemoryRepository(await getMongoDatabase());
    const fragment = await repository.updateFragmentPrivacy({
      groupId,
      fragmentId,
      authorUserId: session.user.id,
      visibility: input.visibility as "private" | "group" | "restricted",
      aiProcessingConsent: input.aiProcessingConsent,
    });
    if (!fragment) return Response.json({ error: "Fragment not found" }, { status: 404 });
    if (
      (fragment.visibility !== "group" || !fragment.aiProcessingConsent) &&
      process.env.TIGER_DATABASE_URL
    ) {
      await new TigerDataFragmentSearch().removeGroupVisibleFragment(groupId, fragmentId);
    }
    const { storageUri: _storageUri, ...visibleFragment } = fragment;
    return Response.json({ fragment: visibleFragment }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ groupId: string; fragmentId: string }> },
) {
  try {
    const { groupId, fragmentId } = await context.params;
    const { session, membership } = await requireGroupMembership(request.headers, groupId);
    const database = await getMongoDatabase();
    const repository = new MongoMemoryRepository(database);
    const fragment = await repository.findFragmentById(groupId, fragmentId);
    if (!fragment) return Response.json({ error: "Fragment not found" }, { status: 404 });
    if (fragment.source === "upload" && !getTemporalSettings()) {
      throw new TemporalConfigurationError();
    }
    if (fragment.source === "upload" && !isPrivateObjectStorageConfigured()) {
      throw new ObjectStorageConfigurationError();
    }
    if (fragment.source === "upload") await getTemporalClient();
    const requested = await repository.requestFragmentDeletion({
      groupId,
      fragmentId,
      actorUserId: session.user.id,
      canManageGroup: membership.role === "owner" || membership.role === "admin",
    });
    if (!requested) return Response.json({ error: "Fragment not found" }, { status: 404 });
    if (process.env.TIGER_DATABASE_URL) {
      await new TigerDataFragmentSearch().removeGroupVisibleFragment(groupId, fragmentId);
    }
    if (fragment.source === "upload") {
      const ingestionRepository = new MongoIngestionRepository(database);
      const job = await ingestionRepository.upsertProcessingJob({
        groupId,
        fragmentId,
        jobType: "delete_fragment",
        processingVersion: fragment.processingVersion,
      });
      try {
        await startFragmentWorkflow(job, "deleteFragmentWorkflow");
      } catch {
        await ingestionRepository.markProcessingJobFailed({ id: job.id, errorMessage: "temporal_unavailable" });
      }
      return Response.json({ status: "deletion_pending", jobId: job.id }, { status: 202 });
    }
    await new MongoIngestionRepository(database).markFragmentDeletionComplete(groupId, fragmentId);
    return Response.json({ status: "deleted" }, { status: 202 });
  } catch (error) {
    if (error instanceof TemporalConfigurationError) {
      return Response.json({ error: "Processing is not configured on this server" }, { status: 503 });
    }
    if (error instanceof ObjectStorageConfigurationError) {
      return Response.json({ error: "Private object storage is not configured" }, { status: 503 });
    }
    return apiErrorResponse(error);
  }
}