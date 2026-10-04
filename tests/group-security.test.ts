import assert from "node:assert/strict";
import test from "node:test";
import { groupSummaryForMember, membershipAllows, mongoIdVariants } from "../src/lib/auth/group-access";
import {
  confirmedMomentsForEventStory,
  momentForGroupMember,
  visibleMomentsForMember,
} from "../src/lib/auth/group-visibility";
import type { Fragment, Moment } from "../src/lib/domain/memory";

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

test("Mongo group ID lookups match both ObjectId and string references", () => {
  const id = "6ac21137d07284b3a39289b1";
  const values = mongoIdVariants(id);
  assert.equal(values.length, 2);
  assert.equal(String(values[0]), id);
  assert.equal(values[1], id);
  assert.deepEqual(mongoIdVariants("provider-user-id"), ["provider-user-id"]);
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

test("group list projection never exposes provider assistant identifiers", () => {
  const summary = groupSummaryForMember(
    {
      _id: "group-a",
      name: "Group A",
      slug: "group-a",
      description: "Private",
      backboardAssistantId: "provider-secret-id",
    },
    "member",
  );

  assert.deepEqual(summary, {
    id: "group-a",
    name: "Group A",
    slug: "group-a",
    description: "Private",
    memberRole: "member",
  });
  assert.equal("backboardAssistantId" in summary, false);
});

test("moment evidence cannot cross group, visibility, consent, or deletion boundaries", () => {
  const moment = (id: string, groupId: string, evidenceIds: string[]): Moment => ({
    id,
    groupId,
    title: null,
    summary: "candidate",
    confidence: 0.5,
    uncertaintyLabel: "possible",
    uncertaintyReason: "Needs review",
    startAt: new Date("2026-09-04T12:00:00Z"),
    endAt: new Date("2026-09-04T12:10:00Z"),
    status: "candidate",
    evidence: evidenceIds.map((fragmentId) => ({ fragmentId, relationship: "temporal" })),
    createdAt: new Date("2026-09-04T12:10:00Z"),
    updatedAt: new Date("2026-09-04T12:10:00Z"),
  });

  test("member-facing moment views omit internal actor IDs but expose correction undo state", () => {
    const reviewed: Moment = {
      id: "moment-review",
      groupId: "group-a",
      title: null,
      summary: "A possible moment.",
      confidence: 0.5,
      uncertaintyLabel: "possible",
      uncertaintyReason: "Needs review.",
      startAt: new Date("2026-09-04T12:00:00Z"),
      endAt: new Date("2026-09-04T12:05:00Z"),
      status: "candidate",
      evidence: [],
      reviewHistory: [{
        id: "review-event",
        actorUserId: "private-user-id",
        action: "correct",
        occurredAt: new Date("2026-09-04T12:10:00Z"),
        before: {
          title: null,
          summary: "A possible moment.",
          status: "candidate",
          uncertaintyLabel: "possible",
          uncertaintyReason: "Needs review.",
          evidence: [],
          corrections: [],
          mergedIntoMomentId: null,
        },
        after: {
          title: null,
          summary: "A possible moment.",
          status: "candidate",
          uncertaintyLabel: "possible",
          uncertaintyReason: "Needs review.",
          evidence: [],
          corrections: [{ id: "correction-a", type: "place", fragmentId: "fragment-a", value: "North cafeteria" }],
          mergedIntoMomentId: null,
        },
      }],
      corrections: [{ id: "correction-a", type: "place", fragmentId: "fragment-a", value: "North cafeteria" }],
      createdAt: new Date("2026-09-04T12:00:00Z"),
      updatedAt: new Date("2026-09-04T12:10:00Z"),
    };

    const view = momentForGroupMember(reviewed);
    assert.equal(view.canUndoCorrection, true);
    assert.equal("reviewHistory" in view, false);
    assert.equal(JSON.stringify(view).includes("private-user-id"), false);
  });
  const fragment = (
    id: string,
    groupId: string,
    overrides: Partial<Fragment> = {},
  ): Fragment => ({
    id,
    groupId,
    authorUserId: "user-a",
    type: "text",
    storageUri: "private://test",
    caption: null,
    textContent: null,
    source: "text",
    capturedTimeZone: "UTC",
    checksumSha256: null,
    processingVersion: "ingest-v1",
    capturedAt: new Date("2026-09-04T12:00:00Z"),
    createdAt: new Date("2026-09-04T12:00:00Z"),
    metadata: {},
    visibility: "group",
    aiProcessingConsent: true,
    aiProcessingConsentAt: new Date("2026-09-04T12:00:00Z"),
    aiProcessingConsentRevokedAt: null,
    deletionState: "active",
    deletionRequestedAt: null,
    deletionRequestedByUserId: null,
    status: "processed",
    ...overrides,
  });
  const moments = [
    moment("moment-a", "group-a", ["a-visible"]),
    { ...moment("moment-confirmed", "group-a", ["a-visible"]), status: "confirmed" as const },
    moment("moment-b", "group-b", ["b-visible"]),
    moment("moment-cross-group", "group-a", ["b-only"]),
    moment("moment-private", "group-a", ["a-private"]),
    moment("moment-no-consent", "group-a", ["a-no-consent"]),
    moment("moment-deleting", "group-a", ["a-deleting"]),
  ];
  const fragments = [
    fragment("a-visible", "group-a"),
    fragment("b-visible", "group-b"),
    fragment("b-only", "group-b"),
    fragment("a-private", "group-a", { visibility: "private" }),
    fragment("a-no-consent", "group-a", { aiProcessingConsent: false }),
    fragment("a-deleting", "group-a", { deletionState: "pending" }),
  ];

  assert.deepEqual(
    visibleMomentsForMember(moments, fragments).map(({ id }) => id),
    ["moment-a", "moment-confirmed", "moment-b"],
  );
  assert.deepEqual(
    confirmedMomentsForEventStory(moments, fragments).map(({ id }) => id),
    ["moment-confirmed"],
  );
});