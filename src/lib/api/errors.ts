import { AuthConfigurationError } from "@/lib/auth";
import { GroupAccessError } from "@/lib/auth/group-access";
import { BackboardApiError, BackboardConfigurationError } from "@/lib/integrations/backboard-client";
import { GroupBackboardMemoryError } from "@/lib/pipeline/group-backboard-memory";
import { ElevenLabsApiError, ElevenLabsConfigurationError } from "@/lib/integrations/elevenlabs-client";

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
  if (error instanceof GroupBackboardMemoryError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof BackboardConfigurationError) {
    return Response.json({ error: "Backboard is not configured on this server" }, { status: 503 });
  }
  if (error instanceof BackboardApiError) {
    return Response.json({ error: "Backboard could not complete the memory request" }, { status: 503 });
  }
  if (error instanceof ElevenLabsConfigurationError) {
    return Response.json({ error: "Voice transcription is not enabled on this server" }, { status: 503 });
  }
  if (error instanceof ElevenLabsApiError) {
    return Response.json({ error: "ElevenLabs could not transcribe this voice note" }, { status: 503 });
  }
  return Response.json({ error: "The request could not be completed" }, { status: 500 });
}