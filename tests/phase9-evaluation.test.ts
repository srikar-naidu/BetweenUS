import assert from "node:assert/strict";
import test from "node:test";
import { buildPhase9Dataset, phase9CaseCoverage } from "../experiments/phase9/dataset";
import { evaluatePhase9 } from "../experiments/phase9/evaluate";

test("Phase 9 evaluation contains 50–100 synthetic fragments and disjoint event splits", () => {
  const scenarios = buildPhase9Dataset();
  const fragments = scenarios.flatMap((scenario) => scenario.fragments);
  const developmentGroups = new Set(
    scenarios.filter((scenario) => scenario.split === "development")
      .map((scenario) => scenario.groupId),
  );
  const heldOutGroups = new Set(
    scenarios.filter((scenario) => scenario.split === "held_out")
      .map((scenario) => scenario.groupId),
  );
  const developmentEvents = new Set(fragments.filter((fragment) =>
    fragment.split === "development" && fragment.eventId,
  ).map((fragment) => fragment.eventId));
  const heldOutEvents = new Set(fragments.filter((fragment) =>
    fragment.split === "held_out" && fragment.eventId,
  ).map((fragment) => fragment.eventId));

  assert.equal(fragments.length, 84);
  assert.equal(new Set(fragments.map((fragment) => fragment.id)).size, fragments.length);
  assert.deepEqual([...developmentGroups].filter((group) => heldOutGroups.has(group)), []);
  assert.deepEqual([...developmentEvents].filter((event) => heldOutEvents.has(event)), []);
});

test("Phase 9 synthetic fixture covers all difficult cases without exposing private examples", () => {
  const coverage = phase9CaseCoverage(buildPhase9Dataset());
  for (const count of Object.values(coverage)) assert.ok(count > 0);
  const privateFragments = buildPhase9Dataset().flatMap((scenario) =>
    scenario.fragments.filter((fragment) => fragment.visibility === "private"),
  );
  assert.equal(privateFragments.length, 12);
  assert.ok(privateFragments.every((fragment) =>
    fragment.cases.includes("insufficient_evidence"),
  ));
});

test("Phase 9 server acceptance gates validate evidence and reject private and foreign-group IDs", () => {
  const report = evaluatePhase9();

  assert.equal(report.syntheticOnly, true);
  assert.equal(report.fragments, 84);
  assert.equal(report.acceptance.validEvidenceIds, true);
  assert.equal(report.acceptance.privateEvidenceRejected, 12);
  assert.equal(report.acceptance.privateEvidenceLeaks, 0);
  assert.equal(report.acceptance.crossGroupEvidenceRejected, 12);
  assert.equal(report.acceptance.crossGroupEvidenceLeaks, 0);
  assert.equal(report.acceptance.confirmedWithoutMemberAction, 0);
  assert.equal(report.acceptance.singleUploaderInsufficientEvidence, 1);
  assert.equal(report.acceptance.passed, true);
  assert.equal(report.launchGate, "blocked_pilot_false_merge_threshold_not_set");
});
