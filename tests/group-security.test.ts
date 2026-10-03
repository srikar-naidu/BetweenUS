import assert from "node:assert/strict";
import test from "node:test";
import { membershipAllows } from "../src/lib/auth/group-access";

const member = {
  organizationId: "group-a",
  userId: "user-a",
  role: "member",
};

test("group membership is bound to both exact group and authenticated user", () => {
  assert.equal(membershipAllows(member, "group-a", "user-a"), true);
  assert.equal(membershipAllows(member, "group-b", "user-a"), false);
  assert.equal(membershipAllows(member, "group-a", "user-b"), false);
  assert.equal(membershipAllows(null, "group-a", "user-a"), false);
});

test("member role cannot pass an owner/admin route gate", () => {
  assert.equal(
    membershipAllows(member, "group-a", "user-a", ["owner", "admin"]),
    false,
  );
  assert.equal(
    membershipAllows(
      { ...member, role: "admin" },
      "group-a",
      "user-a",
      ["owner", "admin"],
    ),
    true,
  );
});