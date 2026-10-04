import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";
import { getBackboardSettings } from "@/lib/integrations/backboard-client";
import {
  disableGroupBackboard,
  enableGroupBackboard,
} from "@/lib/pipeline/group-backboard-memory";
import { getMongoDatabase } from "@/lib/db/mongodb";
import { MongoBackboardRepository } from "@/lib/repositories/mongodb-backboard-repository";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    await requireGroupMembership(request.headers, groupId);
    const repository = new MongoBackboardRepository(await getMongoDatabase());
    const integration = await repository.findIntegration(groupId);
    const result = await repository.listMemoryLinks(groupId);
    return Response.json({
      configured: Boolean(getBackboardSettings()),
      enabled: integration?.status === "enabled",
      status: integration?.status ?? "disabled",
      sharedCorrections: result.map((link) => ({
        momentId: link.momentId,
        correctionId: link.correctionId,
        status: link.status,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    const { session } = await requireGroupMembership(request.headers, groupId, ["owner", "admin"]);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "A JSON body is required" }, { status: 400 });
    }
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>).enabled !== "boolean"
    ) {
      return Response.json({ error: "An explicit enabled setting is required" }, { status: 400 });
    }
    if ((body as { enabled: boolean }).enabled) {
      const status = await enableGroupBackboard({
        database: await getMongoDatabase(),
        groupId,
        userId: session.user.id,
      });
      return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
    }
    await disableGroupBackboard({ database: await getMongoDatabase(), groupId });
    return Response.json({ status: "disabled" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
