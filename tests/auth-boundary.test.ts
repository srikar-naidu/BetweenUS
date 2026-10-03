import assert from "node:assert/strict";
import test from "node:test";
import { GET as listGroups } from "../src/app/api/groups/route";
import { GET as listGroupFragments } from "../src/app/api/groups/[groupId]/fragments/route";

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