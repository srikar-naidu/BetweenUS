import { AuthConfigurationError } from "@/lib/auth";
import { GroupAccessError } from "@/lib/auth/group-access";

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof AuthConfigurationError) {
    return Response.json(
      { error: "Authentication is not configured on this server" },
      { status: 503 },
    );
  }
  if (error instanceof GroupAccessError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: "The request could not be completed" }, { status: 500 });
}