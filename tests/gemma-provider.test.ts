import assert from "node:assert/strict";
import test from "node:test";
import {
  GemmaProviderError,
  OllamaGemmaProvider,
} from "../src/lib/ai/gemma-provider";

const config = {
  baseUrl: "http://ollama.test",
  model: "test-gemma",
  timeoutMs: 1000,
};

test("Gemma provider requests structured output and parses the model object", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new OllamaGemmaProvider(config, async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ message: { content: '{"ok":true}' } });
  });

  const result = await provider.generateStructured({
    task: "reconstruct_possible_moment",
    contextPacket: { candidate_fragments: [{ id: "f-1" }] },
    responseSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(requestBody?.model, "test-gemma");
  assert.equal(requestBody?.stream, false);
  assert.deepEqual(requestBody?.format, {
    type: "object",
    properties: { ok: { type: "boolean" } },
  });
});

test("Gemma provider sends image bytes as base64 and rejects invalid model JSON", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = new OllamaGemmaProvider(config, async (_url, init) => {
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
  const provider = new OllamaGemmaProvider(config, async () =>
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