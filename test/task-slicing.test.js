import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator } from "../src/orchestrator.js";
import { ensureAssignmentIds, scheduleByRole, sequenceAssignments, sliceInfoFor, writeScopesOverlap } from "../src/orchestrator/assignments.js";
import { overlappingSlices, oversizedAssignments } from "../src/orchestrator/guards.js";
import { deliveryNameFor } from "../src/artifacts.js";
import { createPolicyFactory } from "../src/pi-agent.js";
import { createRpcExtension } from "../src/runtime/pi-extension.mjs";
import { createDeliverTool, droppedAssignments, normalizeAssignments } from "../src/agent/tools.js";
import { validateTaskPlan } from "../src/task-plan.js";

const quiet = { info() {}, warn() {}, error() {} };
const client = { im: { message: { create: async () => ({ code: 0 }) } } };

// 记录每次派发的角色、子任务 ID、提示词与任务权限，并统计每个角色同时运行的切片峰值。
function setup() {
  const runs = [];
  const active = new Map();
  const peak = new Map();
  const orch = createOrchestrator({
    log: quiet,
    runAgent: async (agent, prompt, options) => {
      active.set(agent.key, (active.get(agent.key) || 0) + 1);
      peak.set(agent.key, Math.max(peak.get(agent.key) || 0, active.get(agent.key)));
      runs.push({ agentKey: agent.key, taskId: options.taskId, prompt, taskPermissions: options.taskPermissions });
      await new Promise((resolve) => setTimeout(resolve, 5));
      active.set(agent.key, active.get(agent.key) - 1);
      return { text: "done", delivery: { summary: `${agent.key} done`, artifactPaths: [], artifactsDir: "d", final: true } };
    },
  });
  for (const key of ["project_manager", "frontend_developer", "backend_developer"]) orch.registerRole({ key, displayName: key, appId: "x" }, client);
  return { orch, runs, overlapped: () => [...peak.values()].some((count) => count > 1), peakOf: (key) => peak.get(key) || 0 };
}

test("未声明写入范围时同一角色的多个切片依次执行，其他角色并行推进，全部完成后交回项目经理", async () => {
  const { orch, runs, overlapped } = setup();
  await orch.onTaskCompleted("project_manager", "T-slice", {
    delivery: {
      summary: "拆分",
      artifactPaths: [],
      artifactsDir: "d",
      assignments: [
        { id: "fe-login", agentKey: "frontend_developer", task: "登录页", acceptanceCriteria: ["能提交表单"] },
        { id: "fe-list", agentKey: "frontend_developer", task: "列表页" },
        { id: "be-auth", agentKey: "backend_developer", task: "登录接口" },
      ],
    },
    context: { chatId: "c1", channel: "desktop" },
  });
  await orch.whenIdle();
  assert.equal(overlapped(), false, "同角色切片不能并行");
  const frontend = runs.filter((run) => run.agentKey === "frontend_developer");
  assert.equal(frontend.length, 2);
  assert.match(frontend[0].taskId, /:frontend_developer\.fe-login$/);
  assert.match(frontend[1].taskId, /:frontend_developer\.fe-list$/);
  assert.doesNotMatch(frontend[0].prompt, /你只能修改这些路径/);
  assert.match(frontend[0].prompt, /分配任务：登录页/);
  assert.match(frontend[0].prompt, /验收标准：\n- 能提交表单/);
  assert.match(frontend[0].prompt, /第 1\/2 个切片（fe-login）/);
  assert.match(frontend[0].prompt, /fe-list：列表页/);
  assert.match(frontend[1].prompt, /分配任务：列表页/);
  assert.equal(runs.filter((run) => run.agentKey === "backend_developer").length, 1);
  assert.doesNotMatch(runs.find((run) => run.agentKey === "backend_developer").taskId, /backend_developer\./, "单条 assignment 的子任务 ID 保持原格式");
  assert.equal(runs.at(-1).agentKey, "project_manager");
  assert.equal(runs.filter((run) => run.agentKey === "project_manager").length, 1, "只汇总一次");
});

test("显式计划里同一阶段的同角色切片也串行，dependsOn 照常生效", async () => {
  const { orch, runs, overlapped } = setup();
  const slices = [
    { id: "be-model", agentKey: "backend_developer", task: "数据模型" },
    { id: "be-api", agentKey: "backend_developer", task: "接口" },
    { id: "fe-page", agentKey: "frontend_developer", task: "页面", dependsOn: ["be-api"] },
  ];
  const plan = { project: "demo", goal: "g", stages: [{ id: "s1", assignments: slices.slice(0, 2) }, { id: "s2", assignments: slices.slice(2) }] };
  await orch.onTaskCompleted("project_manager", "T-plan-slice", {
    delivery: { summary: "plan", plan, assignments: slices.slice(0, 2), artifactPaths: [], artifactsDir: "d" },
    context: { chatId: "c1", channel: "desktop", projectName: "demo" },
  });
  await orch.whenIdle();
  assert.equal(overlapped(), false);
  assert.deepEqual(runs.map((run) => run.agentKey), ["backend_developer", "backend_developer", "frontend_developer", "project_manager"]);
  assert.match(runs[1].taskId, /\.be-api$/);
});

test("sequenceAssignments 把两条及以上的派发转成计划并补齐 id，单条派发不改写", () => {
  const flat = { summary: "s", assignments: [{ agentKey: "frontend_developer", task: "a" }, { agentKey: "frontend_developer", task: "b" }] };
  const sequenced = sequenceAssignments(flat);
  assert.deepEqual(sequenced.plan.stages[0].assignments.map((item) => item.id), ["frontend_developer-1", "frontend_developer-2"]);
  const distinct = sequenceAssignments({ summary: "s", assignments: [{ agentKey: "frontend_developer", task: "a" }, { agentKey: "backend_developer", task: "b" }] });
  assert.deepEqual(distinct.plan.stages[0].assignments.map((item) => item.id), ["frontend_developer", "backend_developer"]);
  const single = { summary: "s", assignments: [{ agentKey: "frontend_developer", task: "a" }] };
  assert.equal(sequenceAssignments(single), single);
  const withArchitect = sequenceAssignments({ summary: "s", assignments: [{ agentKey: "architect", task: "d" }, ...flat.assignments] });
  assert.deepEqual(withArchitect.plan.stages[1].assignments.map((item) => item.id), ["frontend_developer-1", "frontend_developer-2"]);
  assert.deepEqual(ensureAssignmentIds([{ id: "x", agentKey: "a" }, { id: "x", agentKey: "a" }]).map((item) => item.id), ["x", "x-2"]);
});

test("scheduleByRole 只让写入范围互不重叠的同角色切片并行，并受并发上限约束", () => {
  const items = [{ id: "a", agentKey: "fe" }, { id: "b", agentKey: "fe" }, { id: "c", agentKey: "be" }];
  assert.deepEqual(scheduleByRole(items).map((item) => item.id), ["a", "c"], "没有写入范围时同角色串行");
  assert.deepEqual(scheduleByRole(items, [items[0]]).map((item) => item.id), ["c"]);
  const scoped = [
    { id: "p1", agentKey: "fe", fileWriteAllowlist: ["w/fe/src/pages/login"] },
    { id: "p2", agentKey: "fe", fileWriteAllowlist: ["w/fe/src/pages/list/"] },
    { id: "p3", agentKey: "fe", fileWriteAllowlist: ["w/fe/src/pages/order"] },
    { id: "p4", agentKey: "fe", fileWriteAllowlist: ["w/fe/src/pages"] },
  ];
  assert.deepEqual(scheduleByRole(scoped).map((item) => item.id), ["p1", "p2"], "默认上限 2");
  assert.deepEqual(scheduleByRole(scoped, [], { maxParallel: 4 }).map((item) => item.id), ["p1", "p2", "p3"], "父目录与已选切片重叠");
  assert.deepEqual(scheduleByRole(scoped.slice(1), [scoped[0]], { maxParallel: 1 }).map((item) => item.id), []);
  assert.deepEqual(scheduleByRole([items[0]], [scoped[0]]).map((item) => item.id), [], "没声明范围的切片不和别人并行");
  assert.equal(writeScopesOverlap(["a\\b"], ["a/b/c"]), true);
  assert.equal(writeScopesOverlap(["a/b"], ["a/bc"]), false);
  const plan = { stages: [{ assignments: items }] };
  assert.equal(sliceInfoFor(plan, items[2]), null);
  assert.deepEqual(sliceInfoFor(plan, items[1]), { id: "b", index: 2, total: 2, others: ["a："] });
});

test("normalizeAssignments 允许前端/后端多切片，其他角色仍按角色去重", () => {
  const input = [
    { id: "fe-1", agentKey: "frontend_developer", task: "页面 A", acceptanceCriteria: [" 可见 ", ""] },
    { id: "fe-2", agentKey: "frontend_developer", task: "页面 B" },
    { id: "fe-2", agentKey: "frontend_developer", task: "页面 B 重复" },
    { agentKey: "architect", task: "设计" },
    { agentKey: "architect", task: "再设计" },
  ];
  const result = normalizeAssignments(input, { selfAgentKey: "project_manager" });
  assert.deepEqual(result.map((item) => item.id || item.agentKey), ["fe-1", "fe-2", "architect"]);
  assert.deepEqual(result[0].acceptanceCriteria, ["可见"]);
  assert.deepEqual(droppedAssignments(input, { selfAgentKey: "project_manager" }).map((item) => item.reason), ["重复派发", "重复派发"]);
  const many = Array.from({ length: 10 }, (_, index) => ({ id: `s${index}`, agentKey: "backend_developer", task: `接口 ${index}` }));
  assert.equal(normalizeAssignments(many).length, 8);
});

test("oversizedAssignments 只拦截明显过大的前端/后端任务", () => {
  const big = { id: "fe", agentKey: "frontend_developer", task: ["1. a", "2. b", "3. c", "4. d", "5. e", "6. f"].join("\n") };
  assert.equal(oversizedAssignments([big])[0].reasons[0], "任务里罗列了 6 个条目");
  assert.equal(oversizedAssignments([{ agentKey: "backend_developer", task: "x", acceptanceCriteria: ["1", "2", "3", "4", "5", "6"] }]).length, 1);
  assert.deepEqual(oversizedAssignments([{ agentKey: "architect", task: "x".repeat(2000) }, { agentKey: "frontend_developer", task: "登录页" }]), []);
});

test("deliver_artifact 对过大的派发打回一次，原样重交则放行并记录警告", async () => {
  const root = await mkdtemp(join(tmpdir(), "deliver-slice-"));
  try {
    const delivered = [];
    const tool = createDeliverTool({ root, getArtifactsDir: () => root, getProjectName: () => null, agentKey: "project_manager", agentName: "PM", onDeliver: (delivery) => delivered.push(delivery) });
    const params = { summary: "派发", assignments: [{ agentKey: "frontend_developer", task: "x".repeat(900) }] };
    const first = await tool.execute("c1", params);
    assert.match(first.content[0].text, /任务粒度校验未通过/);
    assert.equal(delivered.length, 0);
    const second = await tool.execute("c2", params);
    assert.match(second.content[0].text, /已交付/);
    assert.equal(delivered[0].granularityWarnings.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("validateTaskPlan 限制计划的切片总数", () => {
  const assignments = Array.from({ length: 13 }, (_, index) => ({ id: `s${index}`, agentKey: "backend_developer", task: "t" }));
  const checked = validateTaskPlan({ project: "demo", goal: "g", stages: [{ id: "s", assignments }] }, { roleLimits: { backend_developer: {} } });
  assert.ok(checked.errors.some((error) => /within 12 slices/.test(error)));
});

test("同角色切片声明了互不重叠的写入范围时并行执行，提示词与权限只含本切片范围", async () => {
  const { orch, runs, peakOf } = setup();
  await orch.onTaskCompleted("project_manager", "T-parallel", {
    delivery: {
      summary: "拆分",
      artifactPaths: [],
      artifactsDir: "d",
      assignments: [
        { id: "fe-login", agentKey: "frontend_developer", task: "登录页", fileWriteAllowlist: ["workspace/demo/frontend/src/pages/login"] },
        { id: "fe-list", agentKey: "frontend_developer", task: "列表页", fileWriteAllowlist: ["workspace/demo/frontend/src/pages/list"] },
        { id: "fe-nav", agentKey: "frontend_developer", task: "注册路由", dependsOn: ["fe-login", "fe-list"] },
      ],
    },
    context: { chatId: "c1", channel: "desktop" },
  });
  await orch.whenIdle();
  assert.equal(peakOf("frontend_developer"), 2, "前两片同时运行");
  const frontend = runs.filter((run) => run.agentKey === "frontend_developer");
  assert.deepEqual(frontend.map((run) => run.taskId.split(".").at(-1)), ["fe-login", "fe-list", "fe-nav"]);
  assert.deepEqual(frontend[0].taskPermissions.fileWriteAllowlist, ["workspace/demo/frontend/src/pages/login"]);
  assert.match(frontend[0].prompt, /你只能修改这些路径：workspace\/demo\/frontend\/src\/pages\/login/);
  assert.match(frontend[0].prompt, /可能与你同时进行/);
  assert.equal(runs.at(-1).agentKey, "project_manager");
  assert.equal(runs.filter((run) => run.agentKey === "project_manager").length, 1);
});

test("overlappingSlices 找出同角色、无依赖且写入范围重叠的切片", () => {
  const items = [
    { id: "a", agentKey: "frontend_developer", task: "A", fileWriteAllowlist: ["w/src/pages"] },
    { id: "b", agentKey: "frontend_developer", task: "B", fileWriteAllowlist: ["w/src/pages/list"] },
    { id: "c", agentKey: "frontend_developer", task: "C", fileWriteAllowlist: ["w/src/pages/x"], dependsOn: ["a"] },
    { id: "d", agentKey: "backend_developer", task: "D", fileWriteAllowlist: ["w/src/pages"] },
    { id: "e", agentKey: "frontend_developer", task: "E" },
  ];
  assert.deepEqual(overlappingSlices(items), [{ agentKey: "frontend_developer", ids: ["a", "b"] }]);
});

test("deliver_artifact 对写入范围重叠的切片打回一次，重交后放行并记录警告", async () => {
  const root = await mkdtemp(join(tmpdir(), "deliver-overlap-"));
  try {
    const delivered = [];
    const tool = createDeliverTool({ root, getArtifactsDir: () => root, getProjectName: () => null, agentKey: "project_manager", agentName: "PM", onDeliver: (delivery) => delivered.push(delivery) });
    const params = { summary: "派发", assignments: [
      { id: "a", agentKey: "frontend_developer", task: "A", fileWriteAllowlist: ["w/src"] },
      { id: "b", agentKey: "frontend_developer", task: "B", fileWriteAllowlist: ["w/src/b"] },
    ] };
    const first = await tool.execute("c1", params);
    assert.match(first.content[0].text, /写入范围重叠：a 与 b（frontend_developer）/);
    assert.doesNotMatch(first.content[0].text, /任务粒度校验未通过/);
    await tool.execute("c2", params);
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0].assignments.map((item) => item.fileWriteAllowlist), [["w/src"], ["w/src/b"]]);
    assert.match(delivered[0].granularityWarnings[0].reasons[0], /写入范围重叠/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("交付文件按切片命名，并行切片不会互相覆盖", async () => {
  assert.equal(deliveryNameFor("frontend_developer", "T1:project_manager:frontend_developer.fe-login"), "frontend_developer.fe-login");
  assert.equal(deliveryNameFor("frontend_developer", "T1:frontend_developer"), "frontend_developer");
  assert.equal(deliveryNameFor("frontend_developer", "T1:backend_developer.x"), "frontend_developer");
  const root = await mkdtemp(join(tmpdir(), "deliver-name-"));
  try {
    const tool = createDeliverTool({ root, getArtifactsDir: () => root, getProjectName: () => null, agentKey: "frontend_developer", agentName: "FE", taskId: "T1:frontend_developer.fe-login", onDeliver: () => {} });
    await tool.execute("c1", { summary: "done" });
    assert.deepEqual(await readdir(root), ["frontend_developer.fe-login-delivery.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RPC 模式的策略闸门执行任务级写入白名单，交付工具拿到切片任务 ID", async () => {
  const handlers = [];
  let deliverOptions = null;
  const api = { registerTool: () => {}, on: (name, handler) => handlers.push({ name, handler }) };
  const tools = {
    createPolicyFactory,
    createDeliverTool: (options) => { deliverOptions = options; return { name: "deliver_artifact" }; },
    createAgentCliTool: () => ({ name: "agent_cli" }),
    createTaskStatusTool: () => ({ name: "get_task_status" }),
    createProjectTool: () => ({ name: "create_project" }),
  };
  createRpcExtension(api, {
    root: process.cwd(),
    context: { agentKey: "frontend_developer", taskId: "T-rpc:frontend_developer.fe-login", projectName: "demo", taskPermissions: { fileWriteAllowlist: ["workspace/demo/frontend/src/pages/login"] } },
    tools,
  });
  const gate = handlers.find((item) => item.name === "tool_call").handler;
  const ctx = { cwd: process.cwd() };
  assert.equal(await gate({ toolName: "write", input: { path: "workspace/demo/frontend/src/pages/login/index.tsx" } }, ctx), undefined);
  const outside = await gate({ toolName: "write", input: { path: "workspace/demo/frontend/src/pages/list/index.tsx" } }, ctx);
  assert.equal(outside.block, true);
  assert.match(outside.reason, /任务文件写入白名单/);
  assert.equal(deliverOptions.taskId, "T-rpc:frontend_developer.fe-login");
});

test("切片状态变化时广播 plan_progress 快照，计划被放弃时广播 cleared", async () => {
  const events = [];
  const orch = createOrchestrator({
    log: quiet,
    onEvent: async (event) => events.push(event),
    runAgent: async (agent) => ({ text: "done", delivery: { summary: `${agent.key} done`, artifactPaths: [], artifactsDir: "d", final: true } }),
  });
  for (const key of ["project_manager", "frontend_developer"]) orch.registerRole({ key, displayName: key, appId: "x" }, client);
  await orch.onTaskCompleted("project_manager", "T-progress", {
    delivery: { summary: "拆分", artifactPaths: [], artifactsDir: "d", assignments: [
      { id: "a", agentKey: "frontend_developer", task: "切片 A" },
      { id: "b", agentKey: "frontend_developer", task: "切片 B" },
    ] },
    context: { chatId: "c1", channel: "desktop" },
  });
  await orch.whenIdle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const snapshots = events.filter((event) => event.type === "plan_progress" && event.task_id === "T-progress");
  assert.deepEqual(snapshots[0].slices.map((slice) => slice.status), ["running", "pending"]);
  assert.deepEqual(snapshots.at(-1).slices.map((slice) => slice.status), ["completed", "completed"]);
  assert.equal(snapshots.at(-1).completed, 2);
  assert.equal(snapshots[0].slices[0].title, "切片 A");

  await orch.onTaskCompleted("project_manager", "T-progress-2", {
    delivery: { summary: "拆分", artifactPaths: [], artifactsDir: "d", assignments: [
      { id: "a", agentKey: "frontend_developer", task: "A" },
      { id: "b", agentKey: "frontend_developer", task: "B" },
    ] },
    context: { chatId: "c1", channel: "desktop", requireHumanApproval: true },
  });
  await orch.terminateTask("T-progress-2").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.filter((event) => event.type === "plan_progress" && event.task_id === "T-progress-2").at(-1).cleared, true);
});

test("切片结束时记录 slice_finished；summarizeSliceStats 按角色、规模与门禁汇总", async () => {
  const { summarizeSliceStats } = await import("../src/slice-stats.js");
  const events = [];
  let failed = false;
  const orch = createOrchestrator({
    log: quiet,
    onEvent: async (event) => events.push(event),
    runAgent: async (agent, prompt) => {
      if (agent.key === "frontend_developer" && prompt.includes("分配任务：B") && !failed) { failed = true; throw new Error("boom"); }
      return { text: "done", delivery: { summary: "done", artifactPaths: [], artifactsDir: "d", final: true } };
    },
  });
  for (const key of ["project_manager", "frontend_developer"]) orch.registerRole({ key, displayName: key, appId: "x" }, client);
  await orch.onTaskCompleted("project_manager", "T-stats", {
    delivery: { summary: "拆分", artifactPaths: [], artifactsDir: "d", assignments: [
      { id: "a", agentKey: "frontend_developer", task: "A", acceptanceCriteria: ["1", "2", "3", "4"], fileWriteAllowlist: ["x/a"] },
      { id: "b", agentKey: "frontend_developer", task: "B" },
    ] },
    context: { chatId: "c1", channel: "desktop" },
  });
  await orch.whenIdle();
  const finished = events.filter((event) => event.type === "slice_finished");
  assert.deepEqual(finished.map((event) => [event.assignment_id, event.status, event.criteria_count, event.write_scope_count]), [["a", "completed", 4, 1], ["b", "failed", 0, 0]]);
  assert.ok(finished.every((event) => Number.isFinite(event.duration_ms) && event.parent_task_id === "T-stats"));

  const stats = summarizeSliceStats([
    ...finished,
    { type: "delivery_received", agent: "project_manager", slice_gate_rejected: true, granularity_warnings: 1 },
    { type: "delivery_received", agent: "project_manager", slice_gate_rejected: false, granularity_warnings: 0 },
    { type: "delivery_received", agent: "frontend_developer" },
  ]);
  assert.equal(stats.total.count, 2);
  assert.equal(stats.by_role.frontend_developer.failure_rate, 0.5);
  assert.equal(stats.by_criteria_count["4-5 条"].completed, 1);
  assert.equal(stats.by_criteria_count["0-1 条"].failed, 1);
  assert.equal(stats.parallel.parallel.count, 1);
  assert.deepEqual(stats.slice_gate, { pm_deliveries: 2, rejected: 1, rejection_rate: 0.5, passed_with_warnings: 1 });
});

test("项目经理一次派发前后端各一条：广播带项目名的进度，两边都交付后才汇总", async () => {
  const events = [];
  const order = [];
  const orch = createOrchestrator({
    log: quiet,
    onEvent: async (event) => events.push(event),
    runAgent: async (agent) => {
      order.push(`start:${agent.key}`);
      // 后端先完成、前端慢：扁平并行时后端一完成就会提前触发项目经理汇总。
      await new Promise((resolve) => setTimeout(resolve, agent.key === "frontend_developer" ? 30 : 5));
      order.push(`end:${agent.key}`);
      return { text: "done", delivery: { summary: `${agent.key} done`, artifactPaths: [], artifactsDir: "d", final: true } };
    },
  });
  for (const key of ["project_manager", "frontend_developer", "backend_developer"]) orch.registerRole({ key, displayName: key, appId: "x" }, client);
  await orch.onTaskCompleted("project_manager", "T-two", {
    delivery: { summary: "S2", artifactPaths: [], artifactsDir: "d", projectName: "test99", assignments: [
      { id: "be-register-api", agentKey: "backend_developer", task: "注册接口" },
      { id: "fe-register-page", agentKey: "frontend_developer", task: "注册页面" },
    ] },
    context: { chatId: "desktop-local", channel: "desktop", projectName: "test99" },
  });
  await orch.whenIdle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(order.indexOf("start:project_manager") > order.indexOf("end:frontend_developer"), "项目经理在两边都完成后才汇总");
  assert.equal(order.filter((item) => item === "start:project_manager").length, 1);
  const progress = events.filter((event) => event.type === "plan_progress");
  assert.ok(progress.length >= 2);
  assert.ok(progress.every((event) => event.project_name === "test99"), "进度事件带项目名，桌面端按项目订阅时才能收到");
  assert.deepEqual(progress[0].slices.map((slice) => slice.status), ["running", "running"]);
  assert.ok(events.filter((event) => event.type === "slice_finished").every((event) => event.project_name === "test99"));
});
