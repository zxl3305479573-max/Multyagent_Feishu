import test from "node:test";
import assert from "node:assert/strict";
import { validateTaskPlan } from "../src/task-plan.js";
import { createDeliverTool } from "../src/pi-agent.js";

const limits = {
  architect: {
    tools: ["read", "grep", "write", "bash"],
    readPaths: ["workspace/demo"],
    writePaths: ["workspace/demo/artifacts"],
    networkAccess: false,
  },
  tester: {
    tools: ["read", "bash"],
    readPaths: ["workspace/demo"],
    writePaths: ["workspace/demo/artifacts"],
    networkAccess: false,
  },
};

function plan() {
  return {
    project: "demo",
    goal: "Build and verify a feature",
    stages: [
      { id: "design", assignments: [{ id: "architecture", agentKey: "architect", task: "Design it", dependsOn: [], toolAllowlist: ["read", "write"], fileReadAllowlist: ["workspace/demo"], fileWriteAllowlist: ["workspace/demo/artifacts"], networkPolicy: { enabled: false }, acceptanceCriteria: ["Design exists"] }] },
      { id: "verify", assignments: [{ id: "tests", agentKey: "tester", task: "Verify design", dependsOn: ["architecture"], toolAllowlist: ["read", "bash"], fileReadAllowlist: ["workspace/demo"], fileWriteAllowlist: ["workspace/demo/artifacts"], networkPolicy: { enabled: false }, acceptanceCriteria: ["Tests pass"] }] },
    ],
  };
}

test("accepts staged plans with dependencies and permissions within role limits", () => {
  const result = validateTaskPlan(plan(), { projectName: "demo", roleLimits: limits });
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.deepEqual(result.plan.stages.map((stage) => stage.id), ["design", "verify"]);
});

test("rejects a plan bound to another project", () => {
  const result = validateTaskPlan(plan(), { projectName: "other", roleLimits: limits });
  assert.ok(result.errors.some((error) => error.includes("project")));
});

test("rejects permissions that exceed the assigned role limits", () => {
  const input = plan();
  input.stages[0].assignments[0].toolAllowlist.push("subagent");
  input.stages[0].assignments[0].fileWriteAllowlist.push("workspace/demo/src");
  input.stages[0].assignments[0].networkPolicy = { enabled: true, domains: ["example.com"] };
  const result = validateTaskPlan(input, { projectName: "demo", roleLimits: limits });
  assert.ok(result.errors.some((error) => error.includes("tool")));
  assert.ok(result.errors.some((error) => error.includes("write")));
  assert.ok(result.errors.some((error) => error.includes("network")));
});

test("rejects unknown, forward, and cyclic dependencies", () => {
  const input = plan();
  input.stages[0].assignments[0].dependsOn = ["tests"];
  input.stages[1].assignments[0].dependsOn = ["missing"];
  const result = validateTaskPlan(input, { projectName: "demo", roleLimits: limits });
  assert.ok(result.errors.some((error) => error.includes("prior stage")));
  assert.ok(result.errors.some((error) => error.includes("unknown dependency")));
});

test("rejects malformed and duplicate assignment identifiers", () => {
  const input = plan();
  input.stages[1].assignments[0].id = "architecture";
  const result = validateTaskPlan(input, { projectName: "demo", roleLimits: limits });
  assert.ok(result.errors.some((error) => error.includes("duplicate assignment id")));
});

test("project manager delivery rejects an invalid structured plan before saving", async () => {
  let delivered = null;
  const tool = createDeliverTool({
    getArtifactsDir: () => "workspace/demo/artifacts/T-1",
    getProjectName: () => "demo",
    agentKey: "project_manager",
    agentName: "项目经理",
    roleLimits: { architect: { tools: ["read"], readPaths: ["workspace/demo/artifacts"], writePaths: ["workspace/demo/artifacts"] } },
    onDeliver: (value) => { delivered = value; },
  });
  const result = await tool.execute("call-1", { summary: "plan", plan: { project: "demo", goal: "x", stages: [{ id: "s1", assignments: [{ id: "a1", agentKey: "architect", task: "x", toolAllowlist: ["bash"] }] }] } });
  assert.match(result.content[0].text, /计划校验失败/);
  assert.equal(delivered, null);
});
