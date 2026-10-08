import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/domain/task-store.js";
import { createDesktopTaskSubmitter } from "../src/desktop-task.js";

test("desktop task submitter creates an isolated project task and sends it through the project manager", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-task-"));
  try {
    const store = new TaskStore(join(root, "tasks.json"));
    const events = [];
    const calls = [];
    const orchestrator = {
      onTaskCompleted: async (...args) => calls.push(["completed", ...args]),
    };
    const runAgent = async (agent, prompt, context) => {
      calls.push(["run", agent.key, prompt, context]);
      await context.onEvent({ type: "agent_started", task_id: context.taskId, agent: agent.key, project_name: context.projectName });
      return {
        text: "项目经理已完成规划",
        projectName: context.projectName,
        delivery: { agentKey: agent.key, agentName: agent.displayName, summary: "规划完成", artifactPaths: [], next: "无需后续操作", final: true },
      };
    };
    const submit = createDesktopTaskSubmitter({
      taskStore: store,
      orchestrator,
      runAgent,
      projectManagerAgent: { key: "project_manager", displayName: "项目经理", appId: "pm-app" },
      recordEvent: async (event) => { events.push(event); return { ...event, event_id: `event-${events.length}` }; },
      loadProjectSummary: async (agentKey, projectName) => ({ path: `${projectName}/summary.md`, content: "历史摘要" }),
      idFactory: () => "desktop-msg-1",
    });

    const accepted = await submit({ projectName: "student", title: "学生系统", description: "实现登录与成绩查询" });
    assert.equal(accepted.status, "accepted");
    assert.match(accepted.taskId, /^TASK-/);
    await submit.whenIdle();

    const task = await store.get(accepted.taskId);
    assert.equal(task.project_name, "student");
    assert.equal(task.source_chat_id, "desktop-local");
    assert.equal(task.agent, "project_manager");
    assert.equal(task.title, "学生系统");
    assert.equal(task.description, "实现登录与成绩查询");
    const runCall = calls.find((item) => item[0] === "run");
    assert.equal(runCall[3].channel, "desktop");
    assert.equal(runCall[3].projectName, "student");
    assert.equal(runCall[3].chatId, "desktop-local");
    assert.match(runCall[2], /学生系统/);
    assert.match(runCall[2], /实现登录与成绩查询/);
    assert.equal(calls.find((item) => item[0] === "completed")[3].context.projectName, "student");
    assert.ok(events.some((event) => event.type === "task_created" && event.project_name === "student"));
    assert.ok(events.some((event) => event.type === "task_completed" && event.project_name === "student"));

    const raw = await readFile(join(root, "tasks.json"), "utf8");
    assert.match(raw, /student/);

    const duplicate = await submit({ projectName: "student", title: "学生系统", description: "实现登录与成绩查询", requestId: "retry-1" });
    const retry = await submit({ projectName: "student", title: "学生系统", description: "实现登录与成绩查询", requestId: "retry-1" });
    await submit.whenIdle();
    assert.equal(retry.duplicate, true);
    assert.equal(retry.taskId, duplicate.taskId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop task submitter rejects missing project or description before creating a task", async () => {
  const store = { create: async () => { throw new Error("must not create"); } };
  const submit = createDesktopTaskSubmitter({
    taskStore: store,
    orchestrator: { onTaskCompleted: async () => {} },
    projectManagerAgent: { key: "project_manager" },
    runAgent: async () => ({}),
  });
  await assert.rejects(() => submit({ projectName: "", description: "做事" }), /projectName/);
  await assert.rejects(() => submit({ projectName: "demo", description: "" }), /description/);
});

test("desktop task submitter refuses a project switch returned by the project manager", async () => {
  const events = [];
  const store = new TaskStore(join(await mkdtemp(join(tmpdir(), "desktop-mismatch-")), "tasks.json"));
  const submit = createDesktopTaskSubmitter({
    taskStore: store,
    orchestrator: { onTaskCompleted: async () => assert.fail("cross-project delivery must not be dispatched") },
    runAgent: async () => ({ projectName: "other-project", delivery: { summary: "wrong project" } }),
    projectManagerAgent: { key: "project_manager" },
    recordEvent: async (event) => events.push(event),
  });
  await submit({ projectName: "selected-project", description: "Do not cross project boundary" });
  await submit.whenIdle();
  assert.ok(events.some((event) => event.type === "task_failed" && /项目不一致/.test(event.error)));
});
