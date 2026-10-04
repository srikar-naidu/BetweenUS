import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getMongoDatabase } from "@/lib/db/mongodb";
import {
  deleteCorrectionMemory,
  GroupBackboardMemoryError,
  publishConfirmedCorrection,
} from "@/lib/pipeline/group-backboard-memory";
import { MongoBackboardRepository } from "@/lib/repositories/mongodb-backboard-repository";

export const runtime = "nodejs";

async function parseInput(request: Request): Promise<{ momentId: string; correctionId: string } | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  if (
    typeof input.momentId !== "string" ||
    !input.momentId ||
    input.momentId.length > 128 ||
    typeof input.correctionId !== "string" ||
    !input.correctionId ||
    input.correctionId.length > 128
  ) return null;
  return { momentId: input.momentId, correctionId: input.correctionId };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    await requireGroupMembership(request.headers, groupId);
    const input = await parseInput(request);
    if (!input) return Response.json({ error: "Moment and correction IDs are required" }, { status: 400 });
    const result = await publishConfirmedCorrection({
      database: await getMongoDatabase(),
      groupId,
      ...input,
    });
    return Response.json({ status: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof GroupBackboardMemoryError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    await requireGroupMembership(request.headers, groupId);
    const input = await parseInput(request);
    if (!input) return Response.json({ error: "Moment and correction IDs are required" }, { status: 400 });
    const repository = new MongoBackboardRepository(await getMongoDatabase());
    const link = await repository.findMemoryLink(groupId, input.correctionId);
    if (!link || link.momentId !== input.momentId) {
      return Response.json({ error: "Shared correction not found" }, { status: 404 });
    }
    await deleteCorrectionMemory({
      database: await getMongoDatabase(),
      groupId,
      correctionId: input.correctionId,
    });
    return Response.json({ status: "removed" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof GroupBackboardMemoryError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return apiErrorResponse(error);
  }
}
