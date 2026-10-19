import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/domain/task-store.js";
import { createOrchestrator } from "../src/orchestrator.js";
import { configureTaskStore, createTask } from "../src/tasks.js";
import { buildQualityReport, formatQualityReportSummary } from "../src/quality-report.js";
import {
  acceptanceFailureRouting,
  createQualityGates,
  evaluateAcceptanceMatrix,
  missingAcceptanceEvidence,
  qualityGateReady,
  qualityPolicyForTask,
  requestsQualitySkip,
  reduceQualityGates,
  validateAcceptanceMatrix,
  validateIntegrationSlice,
} from "../src/quality-gates.js";

test("quality policy requires independent acceptance, evidence and audit for every implementation task", () => {
  const policy = qualityPolicyForTask({ team: true, mode: "auto", description: "实现登录页面和会话认证" });
  assert.equal(policy.independentAcceptance, true);
  assert.equal(policy.acceptanceMatrix, true);
  assert.equal(policy.e2e, true);
  assert.equal(policy.audit, true);
  assert.deepEqual(policy.requiredEvidence, ["typecheck", "test", "build", "e2e"]);
  const ordinary = qualityPolicyForTask({ team: true, mode: "auto", description: "实现数据导出接口" });
  assert.equal(ordinary.independentAcceptance, true);
  assert.equal(ordinary.audit, true, "普通实现任务也必须经过审计");
  assert.equal(qualityPolicyForTask({ team: true, mode: "ask", description: "解释代码" }).independentAcceptance, false);
  assert.equal(qualityPolicyForTask({ team: true, singleRole: true, mode: "auto", description: "登录" }).independentAcceptance, false);
});

test("only an explicit user request can skip both testing and audit", () => {
  assert.equal(requestsQualitySkip("实现页面并跳过测试和审计"), true);
  assert.equal(requestsQualitySkip("测试和审计都跳过"), true);
  assert.equal(requestsQualitySkip("不需要测试和审计"), true);
  assert.equal(requestsQualitySkip("不要跳过测试和审计"), false);
  const skipped = qualityPolicyForTask({ team: true, description: "实现页面，明确跳过测试和审计" });
  assert.equal(skipped.skipTestingAndAudit, true);
  assert.equal(skipped.independentAcceptance, false);
  assert.equal(skipped.audit, false);
  assert.deepEqual(skipped.requiredEvidence, []);
  assert.equal(qualityPolicyForTask({ team: false, singleRole: true, description: "实现页面，跳过测试和审计" }).skipTestingAndAudit, false);
});

test("developer and project-manager self-tests are reference-only and cannot satisfy final gates", () => {
  let gates = createQualityGates({ implementationRequired: true, independentAcceptance: true, audit: true });
  gates = reduceQualityGates(gates, { type: "task_plan_completed" });
  gates = reduceQualityGates(gates, { type: "test_result", agent: "backend_developer", status: "failed", command: "npm test" });
  gates = reduceQualityGates(gates, { type: "acceptance_submitted", agent: "project_manager", verdict: "pass", checks: [{ status: "pass" }] });
  assert.equal(gates.self_test, "failed");
  assert.equal(gates.independent_acceptance, "pending", "项目经理自测不能写入独立验收");
  gates = reduceQualityGates(gates, { type: "acceptance_submitted", agent: "tester", verdict: "pass", checks: [{ status: "pass" }] });
  gates = reduceQualityGates(gates, { type: "delivery_received", agent: "auditor", blockers: [] });
  assert.equal(qualityGateReady(gates), true, "开发自测失败不替代 tester 与 auditor 的独立结论");
  gates = reduceQualityGates(gates, { type: "task_settle" });
  assert.equal(gates.product, "passed");
});

test("quality gates do not enter product-complete until independent acceptance and audit pass", () => {
  let gates = createQualityGates(qualityPolicyForTask({ team: true, description: "登录与 Cookie 会话" }));
  gates = reduceQualityGates(gates, { type: "task_plan_completed" });
  gates = reduceQualityGates(gates, { type: "test_result", agent: "backend_developer", status: "passed", command: "npm test" });
  assert.equal(qualityGateReady(gates), false);
  gates = reduceQualityGates(gates, { type: "acceptance_submitted", agent: "tester", verdict: "pass", checks: [{ status: "pass" }], evidence: [{ kind: "command", text: "npm test" }] });
  assert.equal(qualityGateReady(gates), false);
  gates = reduceQualityGates(gates, { type: "delivery_received", agent: "auditor", blockers: [] });
  assert.equal(qualityGateReady(gates), true);
  gates = reduceQualityGates(gates, { type: "task_settle" });
  assert.equal(gates.product, "passed");
  gates = reduceQualityGates(gates, { type: "task_reopened" });
  assert.equal(gates.product, "incomplete");
  assert.equal(gates.independent_acceptance, "pending");
});

test("acceptance matrix requires ownership and evidence fields", () => {
  const valid = validateAcceptanceMatrix([
    { id: "AC1", criterion: "用户可以登录", verifier: "tester", method: "automated", evidence: "playwright report", returnTo: "backend_developer" },
  ], [{ id: "api", agentKey: "backend_developer" }]);
  assert.equal(valid.valid, true);
  const invalid = validateAcceptanceMatrix([
    { id: "AC1", criterion: "", verifier: "nobody", method: "guess", evidence: "", returnTo: "missing" },
  ], [{ id: "api", agentKey: "backend_developer" }]);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length >= 4);
});

test("pass acceptance must include typecheck/test/build/e2e evidence when required", () => {
  const missing = missingAcceptanceEvidence({
    verdict: "pass",
    evidence: [{ kind: "command", text: "npm test passed" }],
  }, ["typecheck", "test", "build", "e2e"]);
  assert.deepEqual(missing, ["typecheck", "test", "build", "e2e"]);
  const complete = missingAcceptanceEvidence({
    verdict: "pass",
    evidence: [
      { kind: "command", command: "npm run typecheck", status: "pass", exitCode: 0 },
      { kind: "command", command: "npm test", status: "pass", exitCode: 0 },
      { kind: "command", command: "npm run build", status: "pass", exitCode: 0 },
      { kind: "screenshot", path: "artifacts/login.png" },
    ],
  }, ["typecheck", "test", "build", "e2e"]);
  assert.deepEqual(complete, []);
});

test("command evidence without a real zero exit code cannot satisfy a gate", () => {
  const missing = missingAcceptanceEvidence({
    evidence: [{ kind: "command", command: "npm test", status: "pass" }],
  }, ["test"]);
  assert.deepEqual(missing, ["test"]);
  const failed = missingAcceptanceEvidence({
    evidence: [{ kind: "command", command: "npm test", status: "fail", exitCode: 1 }],
  }, ["test"]);
  assert.deepEqual(failed, ["test"]);
});

test("acceptance matrix coverage maps checks by AC id and integration slice depends on every work slice", () => {
  const coverage = evaluateAcceptanceMatrix([
    { id: "AC1", criterion: "登录成功" },
    { id: "AC2", criterion: "刷新保持登录" },
  ], {
    checks: [
      { id: "AC1", status: "pass" },
      { id: "AC2", status: "fail" },
    ],
  });
  assert.equal(coverage.passed, 1);
  assert.equal(coverage.failed, 1);
  assert.deepEqual(coverage.uncovered, []);
  assert.deepEqual(coverage.failedIds, ["AC2"]);
  assert.equal(coverage.valid, false);

  const valid = validateIntegrationSlice([
    { id: "api", agentKey: "backend_developer" },
    { id: "page", agentKey: "frontend_developer" },
    { id: "integration", agentKey: "tester", integration: true, dependsOn: ["api", "page"] },
  ]);
  assert.equal(valid.valid, true);
  const invalid = validateIntegrationSlice([
    { id: "api", agentKey: "backend_developer" },
    { id: "integration", agentKey: "tester", integration: true, dependsOn: [] },
  ]);
  assert.equal(invalid.valid, false);

  const routing = acceptanceFailureRouting([
    { id: "AC1", criterion: "登录成功", returnTo: "backend_developer" },
    { id: "AC2", criterion: "刷新恢复", returnTo: "frontend_developer" },
  ], {
    checks: [
      { id: "AC1", status: "fail" },
      { id: "AC2", status: "pass" },
    ],
  });
  assert.deepEqual(routing, [{ id: "AC1", criterion: "登录成功", returnTo: "backend_developer" }]);
});

test("TaskStore persists quality policy and quality gate transitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-store-"));
  try {
    const store = new TaskStore(join(root, "tasks.json"));
    const policy = qualityPolicyForTask({ team: true, description: "登录与认证" });
    const task = await store.create({ task_id: "T-quality", agent: "project_manager", quality_policy: policy });
    assert.equal(task.quality_gates.policy.audit, true);
    await store.applyEvent({ type: "task_plan_completed", task_id: task.task_id });
    await store.applyEvent({ type: "test_result", task_id: task.task_id, agent: "backend_developer", status: "passed", command: "npm test" });
    const updated = await store.get(task.task_id);
    assert.equal(updated.quality_gates.implementation, "passed");
    assert.equal(updated.quality_gates.self_test, "passed");
    assert.equal(updated.status_snapshot.quality_gates.independent_acceptance, "pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quality report and final summary are generated from AC results, commands and exit codes", () => {
  let gates = createQualityGates({
    independentAcceptance: true,
    acceptanceMatrix: true,
    requiredEvidence: ["typecheck", "test", "build", "e2e"],
  });
  gates = reduceQualityGates(gates, {
    type: "task_plan_created",
    acceptance_matrix: [
      { id: "AC1", criterion: "登录成功", verifier: "tester", method: "automated", evidence: "browser", returnTo: "backend_developer" },
      { id: "AC2", criterion: "刷新恢复", verifier: "tester", method: "automated", evidence: "browser", returnTo: "frontend_developer" },
    ],
  });
  gates = reduceQualityGates(gates, { type: "task_plan_completed" });
  gates = reduceQualityGates(gates, { type: "test_result", agent: "backend_developer", status: "passed" });
  gates = reduceQualityGates(gates, {
    type: "acceptance_submitted",
    agent: "tester",
    verdict: "pass",
    checks: [
      { id: "AC1", status: "pass" },
      { id: "AC2", status: "pass" },
    ],
    evidence: [
      { kind: "command", command: "npm run typecheck", status: "pass", exitCode: 0 },
      { kind: "command", command: "npm test", status: "pass", exitCode: 0 },
      { kind: "command", command: "npm run build", status: "pass", exitCode: 0 },
      { kind: "screenshot", path: "workspace/demo/login.png" },
    ],
  });
  const task = {
    task_id: "T-report",
    project_name: "demo",
    title: "登录闭环",
    quality_gates: gates,
    status_snapshot: { risks: ["第三方登录尚未覆盖"] },
  };
  const report = buildQualityReport({ task, settlementPending: true });
  assert.equal(report.acceptance.passedCount, 2);
  assert.equal(report.acceptance.failedCount, 0);
  assert.equal(report.acceptance.uncoveredCount, 0);
  assert.equal(report.productReady, true);
  assert.equal(report.stages.product, "ready_to_settle");
  const summary = formatQualityReportSummary(report);
  assert.match(summary, /AC：通过 2，失败 0，未覆盖 0/);
  assert.match(summary, /npm test（退出码 0）/);
  assert.match(summary, /已知风险：第三方登录尚未覆盖/);
  assert.match(summary, /上线结论：可以上线/);
  assert.match(summary, /quality-report\.md/);
});

test("every implementation task passes independent acceptance and audit before project-manager settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-orchestrator-"));
  const projectName = `quality-${Date.now()}`;
  try {
    const store = new TaskStore(join(root, "tasks.json"));
    configureTaskStore(store);
    const policy = qualityPolicyForTask({ team: true, description: "实现仪表盘页面" });
    const task = await createTask({ agentKey: "project_manager", chatId: "desktop-local", projectName, quality_policy: policy });
    await store.applyEvent({ type: "task_plan_completed", task_id: task.taskId });
    await store.applyEvent({
      type: "task_plan_created",
      task_id: task.taskId,
      acceptance_matrix: [
        { id: "AC1", criterion: "注册流程可完成", verifier: "tester", method: "automated", evidence: "playwright report", returnTo: "frontend_developer" },
      ],
    });
    await store.applyEvent({ type: "test_result", task_id: task.taskId, agent: "frontend_developer", status: "passed", command: "npm test" });
    const runs = [];
    const events = [];
    const log = { info() {}, warn() {}, error() {} };
    const orch = createOrchestrator({
      log,
      onEvent: async (event) => { events.push(event); await store.applyEvent(event); },
      runAgent: async (agent, prompt, context) => {
        runs.push({ agent: agent.key, prompt, context });
        if (agent.key === "tester") {
          return {
            text: "独立验收通过",
            projectName,
            delivery: {
              agentKey: "tester",
              summary: "独立验收通过",
              artifactPaths: [],
              final: true,
              acceptance: {
                verdict: "pass",
                summary: "全部验收通过",
                checks: [{ id: "AC1", title: "注册流程", status: "pass" }],
                evidence: [
                  { kind: "command", command: "npm run typecheck", status: "pass", exitCode: 0 },
                  { kind: "command", command: "npm test", status: "pass", exitCode: 0 },
                  { kind: "command", command: "npm run build", status: "pass", exitCode: 0 },
                  { kind: "screenshot", path: "workspace/quality-demo/artifacts/browser.png" },
                ],
              },
            },
          };
        }
        if (agent.key === "auditor") {
          return { text: "独立审计通过", projectName, delivery: { agentKey: "auditor", summary: "独立审计通过，无阻塞", blockers: [], artifactPaths: [], final: true } };
        }
        return { text: "最终汇总", projectName, delivery: { agentKey: "project_manager", summary: "最终汇总", artifactPaths: [], final: true } };
      },
    });
    orch.registerRole({ key: "project_manager", displayName: "项目经理" }, null);
    orch.registerRole({ key: "tester", displayName: "测试" }, null);
    orch.registerRole({ key: "auditor", displayName: "审计" }, null);
    const context = {
      chatId: "desktop-local",
      channel: "desktop",
      projectName,
      qualityPolicy: policy,
      requireIndependentAcceptance: true,
      requireAcceptanceMatrix: true,
      requireE2E: true,
      requireAudit: true,
    };
    await orch.onTaskCompleted("project_manager", task.taskId, {
      delivery: { agentKey: "project_manager", summary: "实现完成", artifactPaths: [], final: true },
      resultText: "实现完成",
      context,
    });
    await orch.whenIdle();
    assert.deepEqual(runs.map((item) => item.agent), ["tester", "project_manager", "auditor", "project_manager"]);
    const finalTask = await store.get(task.taskId);
    assert.equal(finalTask.quality_gates.independent_acceptance, "passed");
    assert.equal(finalTask.quality_gates.audit, "passed");
    assert.equal(finalTask.quality_gates.product, "passed");
    assert.ok(events.some((event) => event.type === "quality_gate_blocked" && event.gate === "independent_acceptance"));
    assert.ok(events.some((event) => event.type === "quality_gate_blocked" && event.gate === "audit"));
    assert.ok(events.some((event) => event.type === "quality_report_generated" && event.product_ready === true));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(join(process.cwd(), "workspace", projectName), { recursive: true, force: true });
  }
});

test("security-sensitive tasks cannot settle until the auditor passes after independent acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-audit-"));
  const projectName = `quality-audit-${Date.now()}`;
  try {
    const store = new TaskStore(join(root, "tasks.json"));
    configureTaskStore(store);
    const policy = qualityPolicyForTask({ team: true, description: "实现登录认证和 Cookie 会话" });
    const task = await createTask({ agentKey: "project_manager", chatId: "desktop-local", projectName, quality_policy: policy });
    await store.applyEvent({ type: "task_plan_completed", task_id: task.taskId });
    await store.applyEvent({
      type: "task_plan_created",
      task_id: task.taskId,
      acceptance_matrix: [
        { id: "AC1", criterion: "登录认证可完成", verifier: "tester", method: "automated", evidence: "playwright report", returnTo: "backend_developer" },
      ],
    });
    await store.applyEvent({ type: "test_result", task_id: task.taskId, agent: "backend_developer", status: "passed", command: "npm test" });
    const runs = [];
    const events = [];
    const orch = createOrchestrator({
      log: { info() {}, warn() {}, error() {} },
      onEvent: async (event) => { events.push(event); await store.applyEvent(event); },
      runAgent: async (agent, _prompt, context) => {
        runs.push(agent.key);
        if (agent.key === "tester") {
          return { text: "验收通过", projectName, delivery: { agentKey: "tester", summary: "验收通过", artifactPaths: [], final: true, acceptance: { verdict: "pass", checks: [{ id: "AC1", title: "登录", status: "pass" }], evidence: [
            { kind: "command", command: "npm run typecheck", status: "pass", exitCode: 0 },
            { kind: "command", command: "npm test", status: "pass", exitCode: 0 },
            { kind: "command", command: "npm run build", status: "pass", exitCode: 0 },
            { kind: "screenshot", path: "workspace/login.png" },
          ] } } };
        }
        if (agent.key === "auditor") return { text: "安全审计通过", projectName, delivery: { agentKey: "auditor", summary: "安全审计通过，无阻塞", blockers: [], artifactPaths: [], final: true } };
        return { text: "最终汇总", projectName, delivery: { agentKey: "project_manager", summary: "最终汇总", artifactPaths: [], final: true } };
      },
    });
    for (const key of ["project_manager", "tester", "auditor"]) orch.registerRole({ key, displayName: key }, null);
    await orch.onTaskCompleted("project_manager", task.taskId, {
      delivery: { agentKey: "project_manager", summary: "实现完成", artifactPaths: [], final: true },
      resultText: "实现完成",
      context: {
        chatId: "desktop-local", channel: "desktop", projectName, qualityPolicy: policy,
        requireIndependentAcceptance: true, requireAcceptanceMatrix: true, requireE2E: true, requireAudit: true,
      },
    });
    await orch.whenIdle();
    assert.deepEqual(runs, ["tester", "project_manager", "auditor", "project_manager"]);
    const finalTask = await store.get(task.taskId);
    assert.equal(finalTask.quality_gates.independent_acceptance, "passed");
    assert.equal(finalTask.quality_gates.audit, "passed");
    assert.equal(finalTask.quality_gates.product, "passed");
    assert.ok(events.some((event) => event.type === "quality_gate_blocked" && event.gate === "audit"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(join(process.cwd(), "workspace", projectName), { recursive: true, force: true });
  }
});

test("an explicit user request lets the project manager skip both independent testing and audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-skip-"));
  const projectName = `quality-skip-${Date.now()}`;
  try {
    const store = new TaskStore(join(root, "tasks.json"));
    configureTaskStore(store);
    const policy = qualityPolicyForTask({ team: true, description: "实现页面，明确跳过测试和审计" });
    const task = await createTask({ agentKey: "project_manager", chatId: "desktop-local", projectName, quality_policy: policy });
    await store.applyEvent({ type: "task_plan_completed", task_id: task.taskId });
    const events = [];
    const runs = [];
    const orch = createOrchestrator({
      log: { info() {}, warn() {}, error() {} },
      onEvent: async (event) => { events.push(event); await store.applyEvent(event); },
      runAgent: async (agent) => { runs.push(agent.key); return { delivery: { summary: "done", artifactPaths: [], final: true } }; },
    });
    orch.registerRole({ key: "project_manager", displayName: "项目经理" }, null);
    orch.registerRole({ key: "tester", displayName: "测试" }, null);
    orch.registerRole({ key: "auditor", displayName: "审计" }, null);
    await orch.onTaskCompleted("project_manager", task.taskId, {
      delivery: { agentKey: "project_manager", summary: "按用户要求跳过测试与审计", artifactPaths: [], final: true },
      context: { chatId: "desktop-local", channel: "desktop", projectName, qualityPolicy: policy },
    });
    await orch.whenIdle();
    assert.deepEqual(runs, [], "用户明确跳过时不得再拉起 tester 或 auditor");
    const finalTask = await store.get(task.taskId);
    assert.equal(finalTask.quality_policy.skipTestingAndAudit, true);
    assert.equal(finalTask.quality_gates.audit, "not_required");
    assert.equal(finalTask.quality_gates.independent_acceptance, "not_required");
    assert.equal(finalTask.quality_gates.product, "passed");
    assert.equal(events.some((event) => event.type === "quality_gate_blocked"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(join(process.cwd(), "workspace", projectName), { recursive: true, force: true });
  }
});

test("a second submission with invalid acceptance evidence fails the task instead of falling through", async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-evidence-fail-"));
  const projectName = `quality-evidence-${Date.now()}`;
  try {
    const store = new TaskStore(join(root, "tasks.json"));
    configureTaskStore(store);
    const policy = qualityPolicyForTask({ team: true, description: "实现登录页面" });
    const task = await createTask({ agentKey: "project_manager", chatId: "desktop-local", projectName, quality_policy: policy });
    const events = [];
    let testerRuns = 0;
    const orch = createOrchestrator({
      log: { info() {}, warn() {}, error() {} },
      onEvent: async (event) => { events.push(event); await store.applyEvent(event); },
      runAgent: async (agent) => {
        assert.equal(agent.key, "tester");
        testerRuns += 1;
        return {
          text: "验收通过",
          projectName,
          delivery: {
            agentKey: "tester",
            summary: "验收通过",
            artifactPaths: [],
            final: true,
            acceptance: {
              verdict: "pass",
              checks: [{ id: "AC1", title: "登录", status: "pass" }],
              evidence: [{ kind: "command", text: "npm test passed" }],
            },
          },
        };
      },
    });
    orch.registerRole({ key: "project_manager", displayName: "项目经理" }, null);
    orch.registerRole({ key: "tester", displayName: "测试" }, null);
    const context = {
      chatId: "desktop-local",
      channel: "desktop",
      projectName,
      qualityPolicy: policy,
      acceptanceMatrix: [
        { id: "AC1", criterion: "登录", verifier: "tester", method: "automated", evidence: "playwright report", returnTo: "frontend_developer" },
      ],
      requireIndependentAcceptance: true,
      requireAcceptanceMatrix: true,
      requireE2E: true,
      requireAudit: false,
    };
    await orch.onTaskCompleted("tester", `${task.taskId}:tester`, {
      parentTaskId: task.taskId,
      delivery: {
        agentKey: "tester",
        summary: "验收通过",
        artifactPaths: [],
        final: true,
        acceptance: {
          verdict: "pass",
          checks: [{ id: "AC1", title: "登录", status: "pass" }],
          evidence: [{ kind: "command", text: "npm test passed" }],
        },
      },
      resultText: "验收通过",
      context,
    });
    await orch.whenIdle();
    assert.equal(testerRuns, 1);
    assert.ok(events.some((event) => event.type === "acceptance_evidence_correction"));
    assert.ok(events.some((event) => event.type === "task_failed" && event.error.includes("二次仍不合格")));
    assert.ok(!events.some((event) => event.type === "task_settle"));
    const failed = await store.get(task.taskId);
    assert.equal(failed.status_snapshot.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(join(process.cwd(), "workspace", projectName), { recursive: true, force: true });
  }
});
