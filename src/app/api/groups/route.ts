import { randomBytes } from "node:crypto";
import { AuthConfigurationError, getAuth } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api/errors";
import { listGroupsForUser } from "@/lib/auth/group-access";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const groups = await listGroupsForUser(request.headers);
    return Response.json({ groups }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await getAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: "Sign in is required" }, { status: 401 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "A JSON body is required" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ error: "Invalid group details" }, { status: 400 });
    }

    const input = body as Record<string, unknown>;
    if (
      typeof input.name !== "string" ||
      input.name.trim().length < 2 ||
      input.name.trim().length > 80 ||
      (input.description !== undefined &&
        (typeof input.description !== "string" || input.description.length > 500))
    ) {
      return Response.json({ error: "Invalid group details" }, { status: 400 });
    }

    const name = input.name.trim();
    const slugBase = name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "group";
    const organization = await auth.api.createOrganization({
      headers: request.headers,
      body: {
        name,
        slug: `${slugBase}-${randomBytes(4).toString("hex")}`,
        description: typeof input.description === "string" ? input.description.trim() : "",
      },
    });

    return Response.json(
      { group: { ...organization, memberRole: "owner" } },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}