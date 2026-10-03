import assert from "node:assert/strict";
import test from "node:test";
import { GET as listGroups } from "../src/app/api/groups/route";
import { GET as listGroupFragments } from "../src/app/api/groups/[groupId]/fragments/route";
import { getAuthConfigurationStatus } from "../src/lib/auth";

const validAuthEnvironment = {
  MONGODB_URI: "mongodb+srv://cluster.example/between_us",
  BETTER_AUTH_SECRET: "s".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
};

test("auth configuration accepts a valid server environment", () => {
  assert.deepEqual(getAuthConfigurationStatus(validAuthEnvironment), {
    configured: true,
    missing: [],
    invalid: [],
  });
});

test("auth configuration rejects short secrets and invalid URLs without exposing values", () => {
  const status = getAuthConfigurationStatus({
    ...validAuthEnvironment,
    BETTER_AUTH_SECRET: "too-short",
    BETTER_AUTH_URL: "file:///tmp/auth",
  });

  assert.equal(status.configured, false);
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.invalid, ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET"]);
});

test("auth configuration rejects non-MongoDB database URIs", () => {
  const status = getAuthConfigurationStatus({
    ...validAuthEnvironment,
    MONGODB_URI: "https://example.invalid/database",
  });

  assert.equal(status.configured, false);
  assert.deepEqual(status.invalid, ["MONGODB_URI"]);
});

test("group API fails closed when auth and database credentials are absent", async () => {
  const names = [
    "MONGODB_URI",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  for (const name of names) delete process.env[name];
  try {
    const response = await listGroups(new Request("http://localhost/api/groups"));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "Authentication is not configured on this server",
    });

    const fragmentResponse = await listGroupFragments(
      new Request("http://localhost/api/groups/64b000000000000000000001/fragments"),
      { params: Promise.resolve({ groupId: "64b000000000000000000001" }) },
    );
    assert.equal(fragmentResponse.status, 503);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});