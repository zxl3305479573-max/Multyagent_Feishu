import test from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_FIELD_SCHEMA,
  initialBoardState,
  reduceEvent,
  rootTaskIdFor,
  toBitableFields,
} from "../src/domain/bitable-board.js";
import { OWNER_LABELS, STATUS_LABELS } from "../src/domain/bitable-board.js";

test("rootTaskIdFor strips subtask suffixes and ignores untracked events", () => {
  assert.equal(rootTaskIdFor({ type: "dispatch_started", task_id: "T-1:architect" }), "T-1");
  assert.equal(rootTaskIdFor({ type: "task_started", task_id: "T-1" }), "T-1");
  assert.equal(rootTaskIdFor({ type: "dispatch_completed", parent_task_id: "T-2", task_id: "T-2:tester" }), "T-2");
  assert.equal(rootTaskIdFor({ type: "message_received", chat_id: "c1" }), null);
  assert.equal(rootTaskIdFor({ type: "message_ignored", chat_id: "c1" }), null);
});

test("reduceEvent follows the task lifecycle", () => {
  let state = initialBoardState("T-1");
  assert.equal(state.status, "not_found");

  state = reduceEvent(state, {
    type: "task_created",
    task_id: "T-1",
    agent: "project_manager",
    chat_id: "c1",
    text: "做一个学生管理系统",
    timestamp: "2026-09-22T01:00:00.000Z",
  });
  assert.equal(state.status, "received");
  assert.equal(state.owner_agent, "project_manager");
  assert.equal(state.title, "做一个学生管理系统");
  assert.equal(state.chat_id, "c1");

  state = reduceEvent(state, {
    type: "task_started",
    task_id: "T-1",
    agent: "project_manager",
    timestamp: "2026-09-22T01:00:01.000Z",
  });
  assert.equal(state.status, "in_progress");
  assert.equal(state.stage, "task_started");
  assert.equal(state.started_at, "2026-09-22T01:00:01.000Z");

  state = reduceEvent(state, {
    type: "dispatch_started",
    task_id: "T-1:architect",
    parent_task_id: "T-1",
    target: "architect",
    project_name: "student",
    timestamp: "2026-09-22T01:00:02.000Z",
  });
  assert.equal(state.owner_agent, "architect");
  assert.equal(state.project_id, "student");
  assert.equal(state.status, "in_progress");

  state = reduceEvent(state, {
    type: "approval_required",
    task_id: "T-1:architect",
    parent_task_id: "T-1",
    agent: "architect",
    timestamp: "2026-09-22T01:00:03.000Z",
  });
  assert.equal(state.status, "awaiting_approval");

  state = reduceEvent(state, {
    type: "delivery_received",
    task_id: "T-1:architect",
    parent_task_id: "T-1",
    agent: "architect",
    blockers: ["等待产品确认字段命名"],
    risks: ["接口契约可能变更"],
    artifact_paths: ["workspace/student/artifacts/T-1/architecture-plan.md"],
    summary: "架构方案就绪",
    timestamp: "2026-09-22T01:00:04.000Z",
  });
  assert.deepEqual(state.blockers, ["等待产品确认字段命名"]);
  assert.deepEqual(state.risks, ["接口契约可能变更"]);
  assert.deepEqual(state.output_artifacts, ["workspace/student/artifacts/T-1/architecture-plan.md"]);
  assert.equal(state.stage, "delivery");

  state = reduceEvent(state, {
    type: "task_settle",
    task_id: "T-1",
    reason: "final",
    timestamp: "2026-09-22T01:10:00.000Z",
  });
  assert.equal(state.status, "completed");
  assert.equal(state.completed_at, "2026-09-22T01:10:00.000Z");
});

test("reduceEvent marks failures and holds", () => {
  let state = reduceEvent(initialBoardState("T-2"), {
    type: "task_started",
    task_id: "T-2",
    agent: "tester",
    timestamp: "2026-09-22T02:00:00.000Z",
  });

  state = reduceEvent(state, {
    type: "task_hold",
    task_id: "T-2",
    reason: "paused",
    timestamp: "2026-09-22T02:01:00.000Z",
  });
  assert.equal(state.status, "paused");

  state = reduceEvent(state, {
    type: "dispatch_failed",
    task_id: "T-2:tester",
    parent_task_id: "T-2",
    target: "tester",
    error: "npm test failed",
    timestamp: "2026-09-22T02:02:00.000Z",
  });
  assert.equal(state.status, "failed");
  assert.equal(state.error, "npm test failed");
});

test("a non-final task_completed does not close the board row", () => {
  let state = reduceEvent(initialBoardState("T-3"), {
    type: "task_started",
    task_id: "T-3",
    agent: "project_manager",
    timestamp: "2026-09-22T03:00:00.000Z",
  });
  state = reduceEvent(state, {
    type: "task_completed",
    task_id: "T-3",
    agent: "project_manager",
    final: false,
    timestamp: "2026-09-22T03:01:00.000Z",
  });
  assert.equal(state.status, "in_progress");

  state = reduceEvent(state, {
    type: "task_completed",
    task_id: "T-3",
    agent: "project_manager",
    final: true,
    timestamp: "2026-09-22T03:02:00.000Z",
  });
  assert.equal(state.status, "completed");
  assert.equal(state.completed_at, "2026-09-22T03:02:00.000Z");
});

test("toBitableFields maps state onto the declared schema in Chinese", () => {
  const state = {
    ...initialBoardState("T-4"),
    title: "学生管理系统",
    project_id: "student",
    owner_agent: "architect",
    stage: "delivery",
    status: "awaiting_approval",
    current_action: "架构方案就绪",
    blockers: ["等待产品确认"],
    risks: ["契约可能变更", "排期偏紧"],
    output_artifacts: ["workspace/student/artifacts/T-4/architecture-plan.md"],
    started_at: "2026-09-22T01:00:01.000Z",
    updated_at: "2026-09-22T01:00:04.000Z",
    completed_at: null,
  };

  const fields = toBitableFields(state);
  assert.equal(fields["任务编号"], "T-4");
  assert.equal(fields["任务"], "学生管理系统");
  assert.equal(fields["状态"], STATUS_LABELS.awaiting_approval);
  assert.equal(fields["负责人"], OWNER_LABELS.architect);
  assert.equal(fields["阻塞"], "等待产品确认");
  assert.equal(fields["风险"], "契约可能变更\n排期偏紧");
  assert.equal(fields["交付物"], "workspace/student/artifacts/T-4/architecture-plan.md");
  assert.equal(fields["开始时间"], Date.parse("2026-09-22T01:00:01.000Z"));
  assert.equal(fields["更新时间"], Date.parse("2026-09-22T01:00:04.000Z"));
  assert.equal("完成时间" in fields, false);
});

test("every mapped field has a declared schema entry", () => {
  const declared = new Set(BOARD_FIELD_SCHEMA.map((field) => field.name));
  for (const name of Object.keys(toBitableFields(initialBoardState("T-5")))) {
    assert.ok(declared.has(name), `${name} must be declared in BOARD_FIELD_SCHEMA`);
  }
  assert.equal(declared.has("任务编号"), true);
});

test("an unresolved task omits the status cell instead of writing a placeholder", () => {
  const fields = toBitableFields(initialBoardState("T-6"));
  assert.equal("状态" in fields, false);
});

test("board adds progress and control fields but projector never overwrites a human command", () => {
  const names = new Set(BOARD_FIELD_SCHEMA.map((field) => field.name));
  for (const field of ["进度", "执行角色", "控制指令", "控制结果"]) assert.ok(names.has(field));
  const fields = toBitableFields({
    ...initialBoardState("T-7"),
    status: "in_progress",
    progress: 40,
    active_agents: ["architect"],
  });
  assert.equal(fields["进度"], 40);
  assert.equal(fields["执行角色"], "架构设计师");
  assert.equal("控制指令" in fields, false);
  assert.equal("控制结果" in fields, false);
});

test("progress is derived from planned agent completion and terminal completion", () => {
  let state = reduceEvent(initialBoardState("T-8"), {
    type: "task_plan_created", task_id: "T-8", agents: ["architect", "tester"],
  });
  assert.equal(state.progress, 0);
  state = reduceEvent(state, { type: "dispatch_started", task_id: "T-8:architect", target: "architect" });
  assert.deepEqual(state.active_agents, ["architect"]);
  state = reduceEvent(state, { type: "dispatch_completed", task_id: "T-8:architect", target: "architect" });
  assert.equal(state.progress, 50);
  assert.deepEqual(state.active_agents, []);
  state = reduceEvent(state, { type: "task_settle", task_id: "T-8", reason: "final" });
  assert.equal(state.progress, 100);
});

test("control results immediately project paused, resumed, and terminated status", () => {
  let state = reduceEvent(initialBoardState("T-9"), { type: "task_started", task_id: "T-9", agent: "project_manager" });
  state = reduceEvent(state, { type: "control_applied", task_id: "T-9", command: "pause", result: "已暂停" });
  assert.equal(state.status, "paused");
  state = reduceEvent(state, { type: "control_applied", task_id: "T-9", command: "resume", result: "已恢复" });
  assert.equal(state.status, "in_progress");
  state = reduceEvent(state, { type: "control_applied", task_id: "T-9", command: "terminate", result: "已终止" });
  assert.equal(state.status, "terminated");
  assert.equal(toBitableFields(state)["控制结果"], "已终止");
});
