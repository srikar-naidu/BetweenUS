import assert from "node:assert/strict";
import test from "node:test";
import {
  BackboardApiError,
  BackboardClient,
  getBackboardSettings,
} from "../src/lib/integrations/backboard-client";

test("Backboard stays disabled without a server API key and validates its origin", () => {
  assert.equal(getBackboardSettings({ BACKBOARD_API_KEY: "" }), null);
  assert.throws(() => getBackboardSettings({
    BACKBOARD_API_KEY: "test-key",
    BACKBOARD_API_BASE_URL: "http://example.com/api",
  }));
});

test("Backboard client uses server authentication and the documented explicit memory APIs", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new BackboardClient(
    { apiKey: "server-only-key", baseUrl: "https://app.backboard.io/api", timeoutMs: 1000 },
    async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/assistants")) {
        return Response.json({ assistant_id: "assistant-a" }, { status: 201 });
      }
      if (String(input).endsWith("/memories/search")) {
        return Response.json({
          memories: [{ id: "memory-a", content: "Group-confirmed place reference: north cafe", score: 0.8 }],
        });
      }
      return Response.json({ memory_id: "memory-a" }, { status: 201 });
    },
  );

  const assistantId = await client.createGroupAssistant("group-hash");
  const added = await client.addMemory({
    assistantId,
    content: "Group-confirmed place reference: north cafe",
    sourceKey: "opaque-correction-hash",
    correctionType: "place",
  });
  const found = await client.searchMemories({
    assistantId,
    query: "north cafe",
    limit: 3,
  });

  assert.equal(assistantId, "assistant-a");
  assert.equal(added.memoryId, "memory-a");
  assert.equal(found[0]?.content, "Group-confirmed place reference: north cafe");
  assert.ok(calls.every(({ init }) =>
    new Headers(init.headers).get("X-API-Key") === "server-only-key",
  ));
  const postedMemory = JSON.parse(String(calls[1]?.init.body)) as {
    content: string;
    metadata: Record<string, string>;
  };
  assert.deepEqual(postedMemory, {
    content: "Group-confirmed place reference: north cafe",
    metadata: {
      source: "between-us-confirmed-correction",
      source_key: "opaque-correction-hash",
      correction_type: "place",
    },
  });
});

test("Backboard memory operations persist pending then terminal status through the callback", async () => {
  let polls = 0;
  const observed: string[] = [];
  const client = new BackboardClient(
    { apiKey: "test-key", baseUrl: "https://app.backboard.io/api", timeoutMs: 1500 },
    async () => {
      polls += 1;
      return Response.json({ status: polls === 1 ? "in_progress" : "completed", memory_id: "memory-b" });
    },
  );

  const result = await client.waitForOperation("operation-a", async (status) => {
    observed.push(status);
  });

  assert.equal(result.memory_id, "memory-b");
  assert.deepEqual(observed, ["in_progress", "completed"]);
});

test("Backboard errors do not include provider response bodies", async () => {
  const client = new BackboardClient(
    { apiKey: "test-key", baseUrl: "https://app.backboard.io/api", timeoutMs: 1000 },
    async () => new Response("sensitive provider detail", { status: 500 }),
  );

  await assert.rejects(
    client.createGroupAssistant("group-hash"),
    (error: unknown) => error instanceof BackboardApiError &&
      error.statusCode === 500 &&
      !error.message.includes("sensitive provider detail"),
  );
});

test("Backboard operations time out without exposing provider details", async () => {
  let requests = 0;
  const client = new BackboardClient(
    { apiKey: "test-key", baseUrl: "https://app.backboard.io/api", timeoutMs: 1000 },
    async () => {
      requests += 1;
      return Response.json({ status: "in_progress" });
    },
  );

  await assert.rejects(
    client.waitForOperation("operation-a", async () => undefined),
    (error: unknown) => error instanceof BackboardApiError &&
      error.statusCode === null,
  );
  assert.equal(requests, 1);
});
