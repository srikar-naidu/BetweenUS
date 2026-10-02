import { runDemoReconstruction } from "@/lib/pipeline/demo-reconstruction";

export const runtime = "nodejs";

export async function POST() {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ENABLE_DEMO_PIPELINE !== "true"
  ) {
    return new Response(null, { status: 404 });
  }

  try {
    const result = await runDemoReconstruction();
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Moment reconstruction failed";
    return Response.json({ error: message }, { status: 503 });
  }
}