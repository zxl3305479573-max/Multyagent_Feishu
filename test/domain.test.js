import test from "node:test";
import assert from "node:assert/strict";
import { validateTransition } from "../src/domain/task-state.js";
import { createHandoff, validateHandoff } from "../src/domain/handoff.js";

test("task state machine rejects skipping required stages", () => {
  assert.equal(validateTransition("received", "planned").allowed, true);
  assert.equal(validateTransition("received", "completed").allowed, false);
  assert.equal(validateTransition("running", "succeeded").allowed, true);
  assert.equal(validateTransition("succeeded", "completed").allowed, true);
});

test("handoff validation requires summary and evidence-shaped artifacts", () => {
  const handoff = createHandoff({
    taskId: "T-1",
    agent: "frontend_developer",
    status: "completed",
    summary: "完成页面调整",
    artifacts: [{ path: "frontend/a.js", type: "source", digest: "sha256:abc", version: "v1" }],
    evidence: [{ command: "npm test", result: "passed" }],
    nextAction: "交给 tester",
  });
  assert.equal(validateHandoff(handoff).valid, true);
  assert.equal(validateHandoff({ ...handoff, summary: "" }).valid, false);
  assert.equal(validateHandoff({ ...handoff, artifacts: [{ path: "frontend/a.js" }] }).valid, false);
});

