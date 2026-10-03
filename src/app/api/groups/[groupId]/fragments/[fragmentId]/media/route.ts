import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoMemoryRepository } from "@/lib/repositories/mongodb-memory-repository";
import {
  createPresignedDownloadUrl,
  isPrivateObjectStorageConfigured,
  ObjectStorageConfigurationError,
} from "@/lib/storage/r2-object-store";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string; fragmentId: string }> },
) {
  try {
    const { groupId, fragmentId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId);
    const repository = new MongoMemoryRepository(await getMongoDatabase());
    const fragment = await repository.findFragmentById(groupId, fragmentId);
    if (
      !fragment ||
      fragment.deletionState !== "active" ||
      fragment.source !== "upload" ||
      !fragment.storageUri ||
      (fragment.visibility !== "group" && fragment.authorUserId !== session.user.id)
    ) {
      return Response.json({ error: "Fragment not found" }, { status: 404 });
    }
    if (!isPrivateObjectStorageConfigured()) throw new ObjectStorageConfigurationError();
    const url = await createPresignedDownloadUrl(fragment.storageUri);
    return Response.json({ url }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ObjectStorageConfigurationError) {
      return Response.json({ error: "Private object storage is not configured" }, { status: 503 });
    }
    return apiErrorResponse(error);
  }
}
