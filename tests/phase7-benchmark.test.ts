import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSyntheticBenchmark,
  evaluateSyntheticBenchmark,
} from "../experiments/phase7/benchmark";

test("Phase 7 evaluation fixture is synthetic, event-disjoint, and held out by scenario", () => {
  const scenarios = buildSyntheticBenchmark();
  const development = scenarios.filter((scenario) => scenario.split === "development");
  const heldOut = scenarios.filter((scenario) => scenario.split === "held_out");
  const allIds = scenarios.flatMap((scenario) => [
    scenario.anchor.fragmentId,
    ...scenario.candidates.map((candidate) => candidate.fragmentId),
  ]);

  assert.equal(scenarios.length, 12);
  assert.equal(development.length, 8);
  assert.equal(heldOut.length, 4);
  assert.equal(new Set(allIds).size, allIds.length);
  assert.ok(development.every((scenario) => !heldOut.some((item) => item.id === scenario.id)));
  assert.ok(scenarios.every((scenario) =>
    scenario.candidates.length === 5 &&
    scenario.candidates.filter((candidate) => candidate.label === "same_event").length === 2 &&
    scenario.candidates.some((candidate) => candidate.label === "different_event") &&
    scenario.candidates.some((candidate) => candidate.label === "insufficient_evidence"),
  ));
});

test("benchmark reports development and held-out ranking metrics separately", () => {
  const development = evaluateSyntheticBenchmark("development");
  const heldOut = evaluateSyntheticBenchmark("held_out");
  assert.equal(development.pairCount, 40);
  assert.equal(heldOut.pairCount, 20);
  assert.equal(heldOut.labelCounts.same_event, 8);
  assert.equal(heldOut.labelCounts.different_event, 8);
  assert.equal(heldOut.labelCounts.insufficient_evidence, 4);
  assert.ok(heldOut.modalities.voice_transcript > 0);
  assert.ok(heldOut.metrics.productionHybrid.meanReciprocalRank >= 0);
  assert.ok(heldOut.metrics.lexicalTime.meanReciprocalRank >= 0);
});

test("benchmark includes insufficient-evidence candidates in the non-positive ranking pool", () => {
  const report = evaluateSyntheticBenchmark("all");
  assert.equal(report.pairCount, 60);
  assert.equal(report.labelCounts.same_event, 24);
  assert.equal(report.labelCounts.different_event, 24);
  assert.equal(report.labelCounts.insufficient_evidence, 12);
  assert.equal(report.syntheticOnly, true);
  assert.equal(report.benchmark, "betweenus-phase7-synthetic-v1");
});
