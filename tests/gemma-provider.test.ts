import assert from "node:assert/strict";
import test from "node:test";
import {
  GemmaProviderError,
  LocalGemmaAdapter,
  RenderGemmaAdapter,
  type GemmaService,
  createGemmaService,
} from "../src/lib/ai/gemma-provider";

const config = {
  baseUrl: "http://ollama.test",
  model: "test-gemma",
  timeoutMs: 1000,
};

test("Gemma adapters share the service contract and request structured output", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const respond = async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ message: { content: '{"ok":true}' } });
  };
  const services: GemmaService[] = [
    new LocalGemmaAdapter(config, respond),
    new RenderGemmaAdapter({ ...config, baseUrl: "http://betweenus-gemma:11434" }, respond),
  ];

  for (const service of services) {
    const result = await service.generateStructured({
      task: "reconstruct_possible_moment",
      contextPacket: { candidate_fragments: [{ id: "f-1" }] },
      responseSchema: { type: "object", properties: { ok: { type: "boolean" } } },
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(service.modelVersion, "test-gemma");
    assert.equal(requestBody?.model, "test-gemma");
    assert.equal(requestBody?.stream, false);
    assert.equal(requestBody?.think, false);
    assert.deepEqual(requestBody?.format, {
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
    assert.deepEqual(requestBody?.options, {
      temperature: 0,
      num_ctx: 4096,
      num_predict: 2048,
    });
  }
});

test("Gemma reasoning mode is explicitly enabled only for reconstruction requests", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const service = new RenderGemmaAdapter(
    { ...config, baseUrl: "http://betweenus-gemma:11434" },
    async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ message: { content: '{"ok":true}' } });
    },
  );

  await service.generateStructured({
    task: "reconstruct_possible_moment",
    contextPacket: {},
    responseSchema: { type: "object" },
    think: true,
  });

  assert.equal(requestBody?.think, true);
});

test("Gemma provider sends image bytes as base64 and rejects invalid model JSON", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new LocalGemmaAdapter(config, async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ message: { content: "not-json" } });
  });

  await assert.rejects(
    provider.generateStructured({
      task: "analyze_fragment",
      contextPacket: { fragment_id: "f-1" },
      responseSchema: { type: "object" },
      images: [new TextEncoder().encode("image-bytes")],
    }),
    GemmaProviderError,
  );
  const messages = requestBody?.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[1].images, ["aW1hZ2UtYnl0ZXM="]);
});

test("Gemma provider surfaces Ollama HTTP failures", async () => {
  const provider = new LocalGemmaAdapter(config, async () =>
    Response.json({ error: "model not found" }, { status: 404 }),
  );

  await assert.rejects(
    provider.generateStructured({
      task: "analyze_fragment",
      contextPacket: {},
      responseSchema: { type: "object" },
    }),
    /HTTP 404/,
  );
});

test("Gemma runtime selection never routes production to the local development adapter", () => {
  assert.throws(
    () => createGemmaService({ NODE_ENV: "production", GEMMA_RUNTIME: "local" }),
    /Production Gemma processing must use the Render runtime/,
  );
  assert.throws(
    () => createGemmaService({
      NODE_ENV: "production",
      GEMMA_RUNTIME: "render",
      OLLAMA_HOST: "http://localhost:11434",
    }),
    /must not use a loopback host/,
  );

  const render = createGemmaService({
    NODE_ENV: "production",
    OLLAMA_HOST: "http://betweenus-gemma:11434",
  }, async () => Response.json({ message: { content: "{}" } }), () => undefined);
  assert.ok(render instanceof RenderGemmaAdapter);
  assert.ok(createGemmaService({ NODE_ENV: "development" }) instanceof LocalGemmaAdapter);
});

test("Gemma runtime unavailability fails the processing call without exposing prompt data", async () => {
  const service = new LocalGemmaAdapter(config, async () => {
    throw new Error("private fragment text must not appear in runtime diagnostics");
  });

  await assert.rejects(
    service.generateStructured({
      task: "analyze_text_fragment",
      contextPacket: { text_content: "private fragment text" },
      responseSchema: { type: "object" },
    }),
    (error: unknown) =>
      error instanceof GemmaProviderError &&
      error.message === "Could not reach the configured Gemma runtime",
  );
});