import test from "node:test";
import assert from "node:assert/strict";
import { planProgress, readyPlanAssignments } from "../src/plan-scheduler.js";

const plan = { stages: [
  { id: "design", assignments: [{ id: "a", dependsOn: [] }, { id: "b", dependsOn: [] }] },
  { id: "verify", assignments: [{ id: "c", dependsOn: ["a", "b"] }] },
] };

test("readyPlanAssignments runs a stage in parallel and advances only after dependencies complete", () => {
  assert.deepEqual(readyPlanAssignments(plan, []).map((item) => item.id), ["a", "b"]);
  assert.deepEqual(readyPlanAssignments(plan, [], ["a"]).map((item) => item.id), ["b"]);
  assert.deepEqual(readyPlanAssignments(plan, ["a"]).map((item) => item.id), ["b"]);
  assert.deepEqual(readyPlanAssignments(plan, ["a", "b"]).map((item) => item.id), ["c"]);
});

test("planProgress reports completed assignment percentage", () => {
  assert.equal(planProgress(plan, ["a", "b"]), 67);
  assert.equal(planProgress(plan, ["a", "b", "c"]), 100);
});
