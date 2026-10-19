import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator } from "../src/orchestrator.js";
import { createPendingStores } from "../src/orchestrator/pending-store.js";
import { TaskStore } from "../src/domain/task-store.js";
import { configureTaskStore } from "../src/tasks.js";

const quiet = { info() {}, warn() {}, error() {} };
const client = { im: { message: { create: async () => ({ code: 0 }) } } };
const PASSED = { verdict: "pass", summary: "ok", checks: [{ id: "C1", title: "ok", status: "pass" }], evidence: [{ kind: "note", text: "ok" }] };
const done = (agent, summary = `${agent.key} done`) => ({ text: "done", delivery: { agentKey: agent.key, summary, artifactPaths: [], artifactsDir: "d", final: true, ...(agent.key === "tester" ? { acceptance: PASSED } : {}) } });
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function withStore(taskId, fn) {
  const dir = await mkdtemp(join(tmpdir(), "plan-recovery-"));
  const store = new TaskStore(join(dir, "tasks.json"));
  configureTaskStore(store);
  await store.create({ task_id: taskId, agent: "project_manager", source_chat_id: "desktop-local", project_name: "demo" });
  try { await fn({ dir, store }); } finally { await rm(dir, { recursive: true, force: true }); }
}

function register(orch, keys) {
  for (const key of keys) orch.registerRole({ key, displayName: key, appId: "x" }, client);
}

const slicedPlan = {
  agentKey: "project_manager",
  summary: "拆分",
  artifactPaths: [],
  artifactsDir: "d",
  assignments: [
    { id: "a", agentKey: "frontend_developer", task: "切片 A" },
    { id: "b", agentKey: "frontend_developer", task: "切片 B", dependsOn: ["a"] },
  ],
};

test("计划进度落盘；重启后重试从被中断的切片续跑，而不是交回项目经理重新规划", async () => {
  await withStore("RP1", async ({ dir, store }) => {
    const planRunsFile = join(dir, "plan-runs.json");
    // 第一次运行：切片 a 一直在执行（模拟网关在此时重启）。
    const before = createOrchestrator({
      log: quiet,
      planRunsFile,
      onEvent: async (event) => { await store.applyEvent(event); },
      runAgent: () => new Promise(() => {}),
    });
    register(before, ["project_manager", "frontend_developer"]);
    before.onTaskCompleted("project_manager", "RP1", { delivery: slicedPlan, context: { chatId: "desktop-local", channel: "desktop", projectName: "demo" } });
    const readSaved = () => { try { return JSON.parse(readFileSync(planRunsFile, "utf8")).pending.RP1; } catch { return null; } };
    for (let waited = 0; !readSaved()?.started?.length && waited < 3000; waited += 20) await tick();
    const saved = readSaved();
    assert.deepEqual(saved.started, ["a"]);
    assert.equal(saved.dispatchTaskId, "RP1");
    assert.equal(saved.context.channel, "desktop");

    // 重启：任务被 recoverRunning 判为失败，用户点重试。
    await store.applyEvent({ type: "task_failed", task_id: "RP1", error: "网关重启时任务仍在执行，已中断" });
    const prompts = [];
    const after = createOrchestrator({
      log: quiet,
      planRunsFile,
      onEvent: async (event) => { await store.applyEvent(event); },
      runAgent: async (agent, prompt, options) => { prompts.push({ agentKey: agent.key, prompt, taskId: options.taskId }); return done(agent); },
    });
    register(after, ["project_manager", "frontend_developer"]);
    assert.deepEqual(await after.retryTask("RP1"), { retried: true, attempt: 1, resumed: 1 });
    await after.whenIdle();
    assert.deepEqual(prompts.map((item) => item.agentKey), ["frontend_developer", "frontend_developer", "project_manager"]);
    assert.match(prompts[0].prompt, /分配任务：切片 A/);
    assert.match(prompts[0].prompt, /上次执行时被中断/);
    assert.match(prompts[1].prompt, /分配任务：切片 B/);
    assert.doesNotMatch(prompts[1].prompt, /上次执行时被中断/);
    assert.match(prompts[2].prompt, /全部阶段已交付完成/);
    assert.equal(JSON.parse(readFileSync(planRunsFile, "utf8")).pending.RP1, undefined, "计划完成后从文件中移除");
    assert.equal((await store.getStatus("RP1")).status, "completed");
  });
});

test("切片失败只把这一片交回项目经理，替换项放回原位置，依赖它的切片随之改依赖", async () => {
  await withStore("RP2", async ({ store }) => {
    const prompts = [];
    const events = [];
    let failedOnce = false;
    const orch = createOrchestrator({
      log: quiet,
      onEvent: async (event) => { events.push(event); await store.applyEvent(event); },
      runAgent: async (agent, prompt, options) => {
        prompts.push({ agentKey: agent.key, prompt, taskId: options.taskId });
        if (agent.key === "frontend_developer" && /分配任务：切片 A$/m.test(prompt) && !failedOnce) { failedOnce = true; throw new Error("boom"); }
        if (agent.key === "project_manager" && prompt.includes("计划切片 a")) {
          return { text: "x", delivery: { agentKey: "project_manager", summary: "替换", artifactPaths: [], assignments: [{ id: "a-small", agentKey: "frontend_developer", task: "切片 A（缩小）" }] } };
        }
        return done(agent);
      },
    });
    register(orch, ["project_manager", "frontend_developer", "backend_developer"]);
    await orch.onTaskCompleted("project_manager", "RP2", {
      delivery: { ...slicedPlan, assignments: [
        { id: "a", agentKey: "frontend_developer", task: "切片 A" },
        { id: "c", agentKey: "backend_developer", task: "接口 C", dependsOn: ["a"] },
      ] },
      context: { chatId: "desktop-local", channel: "desktop", projectName: "demo" },
    });
    await orch.whenIdle();
    const handed = events.find((event) => event.type === "failure_handed_to_pm");
    assert.equal(handed.assignment_id, "a");
    const pmPrompt = prompts.find((item) => item.agentKey === "project_manager" && item.prompt.includes("计划切片 a"));
    assert.match(pmPrompt.prompt, /其余切片保持原进度/);
    assert.deepEqual(prompts.map((item) => item.agentKey), ["frontend_developer", "project_manager", "frontend_developer", "backend_developer", "project_manager"]);
    assert.match(prompts[2].prompt, /分配任务：切片 A（缩小）/);
    assert.match(prompts[3].prompt, /分配任务：接口 C/);
    assert.match(prompts.at(-1).prompt, /全部阶段已交付完成/);
    assert.doesNotMatch(prompts.at(-1).prompt, /执行失败/, "汇总时不再带着失败说明");
    assert.equal((await store.getStatus("RP2")).status, "completed");
  });
});

test("测试按切片验收标准逐条验收；执行角色只拿依赖切片的完整交付", async () => {
  const prompts = [];
  const longSummary = "B".repeat(200);
  const orch = createOrchestrator({
    log: quiet,
    runAgent: async (agent, prompt, options) => {
      prompts.push({ agentKey: agent.key, prompt, taskId: options.taskId });
      if (options.taskId.endsWith(".be-b") || options.taskId.endsWith(":backend_developer")) return done(agent, longSummary);
      return done(agent, `${agent.key} 完成 ${options.taskId.split(":").at(-1)}`);
    },
  });
  register(orch, ["project_manager", "frontend_developer", "backend_developer", "tester"]);
  const plan = { project: "demo", goal: "g", stages: [
    { id: "s1", assignments: [
      { id: "fe-a", agentKey: "frontend_developer", task: "页面 A", acceptanceCriteria: ["A1 能打开", "A2 能提交"] },
      { id: "be-b", agentKey: "backend_developer", task: "接口 B", acceptanceCriteria: ["B1 返回 200"] },
    ] },
    { id: "s2", assignments: [
      { id: "fe-c", agentKey: "frontend_developer", task: "页面 C", dependsOn: ["fe-a"] },
      { id: "qa", agentKey: "tester", task: "验收", dependsOn: ["fe-a", "be-b"] },
    ] },
  ] };
  await orch.onTaskCompleted("project_manager", "RP3", {
    delivery: { agentKey: "project_manager", summary: "plan", plan, assignments: plan.stages[0].assignments, artifactPaths: [], artifactsDir: "d" },
    context: { chatId: "c1", channel: "desktop", projectName: "demo" },
  });
  await orch.whenIdle();
  const feC = prompts.find((item) => item.prompt.includes("分配任务：页面 C"));
  assert.match(feC.prompt, /frontend_developer（fe-a）: frontend_developer 完成/);
  assert.ok(feC.prompt.includes(`backend_developer（be-b）: ${"B".repeat(80)}…`), "非依赖交付压成一行");
  assert.ok(!feC.prompt.includes("B".repeat(81)));
  const tester = prompts.find((item) => item.agentKey === "tester");
  assert.match(tester.prompt, /按切片验收标准逐条验收/);
  assert.match(tester.prompt, /fe-a-AC1 A1 能打开\n {2}fe-a-AC2 A2 能提交/);
  assert.match(tester.prompt, /be-b-AC1 B1 返回 200/);
  assert.ok(tester.prompt.includes(longSummary), "测试拿全部交付全文");
});

test("计划进度文件：重启时执行中的切片记为中断，过期计划被丢弃", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-store-"));
  try {
    const file = join(dir, "plan-runs.json");
    const plan = { stages: [{ id: "s", assignments: [{ id: "a", agentKey: "frontend_developer", task: "A" }] }] };
    writeFileSync(file, JSON.stringify({ pending: {
      fresh: { plan, completed: [], started: ["a"], failed: [], interrupted: [], dispatchTaskId: "fresh", context: {}, savedAt: Date.now() },
      stale: { plan, completed: [], started: [], failed: [], interrupted: [], savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 },
    } }));
    const { planRuns } = createPendingStores({ planRunsFile: file, approvalTtlMs: 1000, log: quiet });
    assert.deepEqual([...planRuns.keys()], ["fresh"]);
    assert.deepEqual([...planRuns.get("fresh").interrupted], ["a"]);
    assert.equal(planRuns.get("fresh").started.size, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
