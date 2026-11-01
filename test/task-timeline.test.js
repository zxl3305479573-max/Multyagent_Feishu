import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../desktop/renderer/src/task-timeline.ts", import.meta.url), "utf8")
  .replace('import type { AgentExecutionGroup, EventRecord } from "./types";', "")
  .replace('import { eventLabels } from "./labels";', 'const eventLabels = { task_started: "开始规划任务", plan_progress: "切片进度更新", approval_required: "等待确认", task_failed: "执行遇到问题", task_completed: "完成当前阶段" };')
  .replace('import { latestPlanProgress, type PlanProgress } from "./execution-view";', 'const latestPlanProgress = (events) => { const latest = [...events].reverse().find((event) => event.type === "plan_progress"); return latest && !latest.cleared ? { total: latest.slices.length, completed: latest.slices.filter((item) => item.status === "completed").length, running: latest.slices.filter((item) => item.status === "running").length, failed: latest.slices.filter((item) => item.status === "failed").length, slices: latest.slices } : null; };')
  .replace('import { taskStatusToken } from "./themes/task-status";', 'const taskStatusToken = (status) => status === "completed" ? "completed" : status === "failed" ? "failed" : status === "running" ? "running" : status === "awaiting_approval" ? "waiting-approval" : "pending";');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { buildTaskTimeline, summarizeTaskProgress } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("任务时间线由真实事件生成，并标记等待确认和异常", () => {
  const events = [
    { event_id: "1", type: "task_started", timestamp: "2026-01-01T00:00:01Z" },
    { event_id: "2", type: "plan_progress", timestamp: "2026-01-01T00:00:02Z", slices: [
      { id: "s1", agent: "frontend_developer", title: "页面", status: "completed" },
      { id: "s2", agent: "tester", title: "验收", status: "running" },
    ] },
    { event_id: "3", type: "approval_required", timestamp: "2026-01-01T00:00:03Z" },
  ];
  const timeline = buildTaskTimeline(events, "awaiting_approval");
  assert.deepEqual(timeline.map((item) => item.type), ["task_started", "plan_progress", "approval_required"]);
  assert.equal(timeline.at(-1).status, "waiting");
  assert.match(timeline[1].detail, /1\/2/);
  assert.equal(buildTaskTimeline([{ type: "task_failed", event_id: "x" }], "failed")[0].status, "error");
});

test("任务进度优先使用计划切片，其次使用 Agent 执行分组", () => {
  const events = [{ type: "plan_progress", slices: [
    { id: "s1", agent: "frontend_developer", title: "页面", status: "completed" },
    { id: "s2", agent: "backend_developer", title: "接口", status: "running" },
    { id: "s3", agent: "tester", title: "验收", status: "pending" },
  ] }];
  const plan = summarizeTaskProgress(events, [], "running");
  assert.equal(plan.completed, 1);
  assert.equal(plan.total, 3);
  assert.equal(plan.percent, 33);
  const groups = [
    { status: "completed", toolCount: 1 },
    { status: "running", toolCount: 2 },
  ];
  assert.equal(summarizeTaskProgress([], groups, "running").label, "1/2 个 Agent 完成");
});
