import test from "node:test";
import assert from "node:assert/strict";
import { validateDag, readyTasks } from "../src/domain/dag.js";
import { auditDelivery } from "../src/domain/audit.js";

test("DAG rejects missing dependencies and cycles", () => {
  assert.equal(validateDag([{ task_id: "a", depends_on: ["missing"] }]).valid, false);
  assert.equal(validateDag([{ task_id: "a", depends_on: ["b"] }, { task_id: "b", depends_on: ["a"] }]).valid, false);
});

test("DAG returns dependency-ready tasks", () => {
  const tasks = [
    { task_id: "a", status: "completed" },
    { task_id: "b", status: "waiting_dependency", depends_on: ["a"] },
    { task_id: "c", status: "waiting_dependency", depends_on: ["b"] },
  ];
  assert.deepEqual(readyTasks(tasks).map((task) => task.task_id), ["b"]);
});

test("audit gate checks evidence and artifact ownership", () => {
  const handoff = {
    task_id: "t", agent: "frontend_developer", status: "completed", summary: "done",
    artifacts: [{ path: "backend/a.js", type: "source", digest: "sha256:x", version: "v1" }],
    evidence: [{ command: "npm test", result: "passed" }], blockers: [], assumptions: [], risks: [], next_action: "done", created_at: new Date().toISOString(),
  };
  assert.equal(auditDelivery(handoff, { allowedPaths: ["frontend"] }).passed, false);
  assert.equal(auditDelivery({ ...handoff, artifacts: [] }).passed, true);
});
