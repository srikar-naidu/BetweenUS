import { AuthConfigurationError, getAuth } from "@/lib/auth";

export const runtime = "nodejs";

async function handleAuth(request: Request): Promise<Response> {
  try {
    const auth = await getAuth();
    return auth.handler(request);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    throw error;
  }
}

export const GET = handleAuth;
export const POST = handleAuth;