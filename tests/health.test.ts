import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../src/app/api/health/route";

test("health endpoint returns only an application liveness status", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});
