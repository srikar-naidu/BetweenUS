import { getAuth } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api/errors";
import { requireGroupMembership } from "@/lib/auth/group-access";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ groupId: string }> },
) {
  try {
    const { groupId } = await context.params;
    await requireGroupMembership(request.headers, groupId, ["owner", "admin"]);

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
      typeof (body as Record<string, unknown>).email !== "string"
    ) {
      return Response.json({ error: "A valid invitation email is required" }, { status: 400 });
    }

    const email = ((body as Record<string, string>).email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return Response.json({ error: "A valid invitation email is required" }, { status: 400 });
    }

    const auth = await getAuth();
    const result = await auth.api.createInvitation({
      headers: request.headers,
      body: { organizationId: groupId, email, role: "member" },
    });
    const baseUrl = process.env.BETTER_AUTH_URL;
    if (!baseUrl) {
      return Response.json({ error: "The invitation link base URL is not configured" }, { status: 503 });
    }
    return Response.json(
      {
        invitation: result,
        inviteUrl: new URL(`/invite/${encodeURIComponent(result.id)}`, baseUrl).toString(),
        delivery: "copy_link",
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}