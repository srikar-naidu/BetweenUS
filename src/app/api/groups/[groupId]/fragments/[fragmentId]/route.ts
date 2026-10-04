import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoIngestionRepository } from "@/lib/repositories/mongodb-ingestion-repository";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import { TigerDataFragmentSearch } from "@/lib/retrieval/tiger-data";

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
    const legacyMediaCleanupRequired = fragment.source === "upload" && fragment.storageUri !== null;
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
    await new MongoIngestionRepository(database).markFragmentDeletionComplete(groupId, fragmentId);
    return Response.json({ status: "deleted", legacyMediaCleanupRequired }, { status: 202 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}