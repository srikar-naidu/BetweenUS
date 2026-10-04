import assert from "node:assert/strict";
import test from "node:test";
import { extractInvitationId } from "../src/lib/auth/invitation-link";

test("invitation input accepts invitation IDs and full links", () => {
  const invitationId = "6ac21be18fbc5c32e0d58e3f";
  assert.equal(extractInvitationId(invitationId), invitationId);
  assert.equal(extractInvitationId(`/invite/${invitationId}`), invitationId);
  assert.equal(
    extractInvitationId(`https://betweenus.example/invite/${invitationId}?source=share`),
    invitationId,
  );
});

test("invitation input rejects unsafe schemes and unrelated paths", () => {
  assert.equal(extractInvitationId("javascript:alert(1)"), null);
  assert.equal(extractInvitationId("https://example.com/other/6ac21be18fbc5c32e0d58e3f"), null);
  assert.equal(extractInvitationId("/groups/6ac21be18fbc5c32e0d58e3f"), null);
  assert.equal(extractInvitationId("bad code"), null);
});
