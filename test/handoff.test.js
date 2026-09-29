import test from "node:test";
import assert from "node:assert/strict";
import { assertHandoff, validateHandoff } from "../src/domain/handoff.js";

const valid = {
  task_id: "T-001",
  agent: "frontend_developer",
  status: "completed",
  summary: "完成前端修改",
  artifacts: [
    {
      path: "frontend/src/Login.tsx",
      type: "source",
      digest: "sha256:abc",
      version: "commit:abc123",
    },
  ],
  evidence: [{ command: "npm test", result: "passed" }],
  blockers: [],
  assumptions: [],
  risks: [],
  next_action: "交给 tester",
  created_at: "2026-09-18T00:00:00.000Z",
};

test("通过完整交接包校验", () => {
  assert.deepEqual(validateHandoff(valid), { valid: true, errors: [] });
  assert.deepEqual(assertHandoff(valid), valid);
});

test("缺少交接字段时校验失败", () => {
  const result = validateHandoff({ ...valid, summary: "" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("summary"));
  assert.throws(() => assertHandoff({ ...valid, evidence: [] }), /交接包校验失败/);
});

test("交接包产物和证据字段必须是数组对象", () => {
  const result = validateHandoff({ ...valid, artifacts: "file.ts" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("artifacts"));
});

test("交接包拒绝绝对路径和目录穿越产物", () => {
  assert.equal(validateHandoff({ ...valid, artifacts: [{ ...valid.artifacts[0], path: "/etc/passwd" }] }).valid, false);
  assert.equal(validateHandoff({ ...valid, artifacts: [{ ...valid.artifacts[0], path: "../../secret.txt" }] }).valid, false);
  assert.equal(validateHandoff({ ...valid, artifacts: [{ ...valid.artifacts[0], path: "workspace/student/artifacts/T-001/a.md" }] }).valid, true);
});

test("交接包拒绝非字符串字段和证据", () => {
  assert.equal(validateHandoff({ ...valid, task_id: 123 }).valid, false);
  assert.equal(validateHandoff({ ...valid, agent: { key: "tester" } }).valid, false);
  assert.equal(validateHandoff({ ...valid, evidence: [{ command: { runner: "npm test" }, result: "passed" }] }).valid, false);
  assert.equal(validateHandoff({ ...valid, choices: [{ id: "", label: "接受" }] }).valid, false);
});
