import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopHost } from "../src/desktop-host.js";

test("desktop host connects lifecycle controls to the existing task and orchestrator services", async () => {
  const calls = [];
  const recorded = [];
  const taskStore = {
    list: async () => [{ task_id: "T-1" }],
    setPaused: async (id, paused) => { calls.push(["pause", id, paused]); return { task_id: id, paused }; },
  };
  const orchestrator = {
    resumeTask: async (id) => { calls.push(["resume", id]); return 2; },
    terminateTask: async (id) => { calls.push(["terminate", id]); return { terminated: true, aborted: 1 }; },
  };
  const host = createDesktopHost({ token: "desktop-session-token-for-tests", eventsFile: ".tmp/no-events.jsonl", taskStore, orchestrator, recordEvent: async (event) => recorded.push(event) });
  const handlers = host.commandHandlers;
  assert.deepEqual(await handlers.pause({ taskId: "T-1:agent-1" }), { paused: true });
  assert.deepEqual(await handlers.resume({ taskId: "T-1" }), { resumed: 2 });
  assert.deepEqual(await handlers.terminate({ taskId: "T-1" }), { terminated: true, aborted: 1 });
  assert.deepEqual(calls, [["pause", "T-1", true], ["resume", "T-1"], ["terminate", "T-1"]]);
  assert.deepEqual(recorded.map((event) => event.type), ["control_applied", "control_applied", "control_applied"]);
});

test("desktop host retries a failed task and resumes its orchestration checkpoints", async () => {
  const calls = [];
  const recorded = [];
  const host = createDesktopHost({
    token: "desktop-session-token-for-tests",
    eventsFile: ".tmp/no-events.jsonl",
    taskStore: {
      list: async () => [{ task_id: "T-2" }],
    },
    orchestrator: { retryTask: async (id, opts) => { calls.push(["retry", id, opts.error]); return { retried: true, attempt: 2 }; } },
    recordEvent: async (event) => recorded.push(event),
  });

  assert.deepEqual(await host.commandHandlers.retry({ taskId: "T-2", error: "tool timeout" }), { retried: true, attempt: 2 });
  assert.deepEqual(calls, [["retry", "T-2", "tool timeout"]]);
  assert.deepEqual(recorded, [{ type: "control_applied", task_id: "T-2", command: "retry", result: "retrying" }]);
});

test("desktop host exposes task submission as a command", async () => {
  const submitted = [];
  const continued = [];
  const submitTask = async (input) => { submitted.push(input); return { taskId: "TASK-1", status: "accepted" }; };
  submitTask.continueTask = async (input) => { continued.push(input); return { taskId: "TASK-1", status: "accepted", continued: true }; };
  const host = createDesktopHost({
    token: "desktop-session-token-for-tests",
    eventsFile: ".tmp/no-events.jsonl",
    taskStore: { list: async () => [] },
    orchestrator: {},
    submitTask,
  });
  assert.deepEqual(await host.commandHandlers.submit_task({ projectName: "demo", title: "标题", description: "描述" }), { taskId: "TASK-1", status: "accepted" });
  assert.deepEqual(submitted, [{ projectName: "demo", title: "标题", description: "描述" }]);
  assert.deepEqual(await host.commandHandlers.continue_task({ taskId: "TASK-1", message: "继续完善" }), { taskId: "TASK-1", status: "accepted", continued: true });
  assert.deepEqual(continued, [{ taskId: "TASK-1", message: "继续完善" }]);
});

test("desktop host exposes project export and recoverable history cleanup", async () => {
  const calls = [];
  const host = createDesktopHost({
    token: "desktop-session-token-for-tests",
    eventsFile: ".tmp/no-events.jsonl",
    taskStore: { list: async () => [] },
    orchestrator: {},
    exportProject: async (input) => { calls.push(["export", input]); return { outputFile: "export.json" }; },
    cleanupHistory: async (input) => { calls.push(["cleanup", input]); return { archived: 2 }; },
    restoreHistory: async (input) => { calls.push(["restore", input]); return { restored: 2 }; },
  });
  assert.deepEqual(await host.commandHandlers.export_project({ projectName: "demo" }), { outputFile: "export.json" });
  assert.deepEqual(await host.commandHandlers.cleanup_history({ projectName: "demo", keep: 10 }), { archived: 2 });
  assert.deepEqual(await host.commandHandlers.restore_history({ projectName: "demo" }), { restored: 2 });
  assert.deepEqual(calls, [["export", { projectName: "demo" }], ["cleanup", { projectName: "demo", keep: 10 }], ["restore", { projectName: "demo" }]]);
});

test("desktop host exposes capability management and records each change", async () => {
  const calls = [];
  const recorded = [];
  const capability = { kind: "skill", name: "api-review", roles: ["architect"], enabled: true, source: "desktop" };
  const capabilities = {
    list: async () => ({ skills: [capability], plugins: [], roles: ["architect"] }),
    install: async (input) => { calls.push(["install", input]); return capability; },
    assign: async (input) => { calls.push(["assign", input]); return { ...capability, ...input }; },
    assignBase: async (input) => { calls.push(["assignBase", input]); return { agentKey: input.agentKey, name: input.tool, ...input }; },
    remove: async (input) => { calls.push(["remove", input]); return { removed: true }; },
  };
  const host = createDesktopHost({
    token: "desktop-session-token-for-tests",
    eventsFile: ".tmp/no-events.jsonl",
    taskStore: { list: async () => [] },
    orchestrator: {},
    capabilities,
    recordEvent: async (event) => recorded.push(event),
  });
  const handlers = host.commandHandlers;

  assert.deepEqual(await handlers.capabilities_list(), { skills: [capability], plugins: [], roles: ["architect"] });
  assert.deepEqual(await handlers.capabilities_install({ kind: "skill", source: { type: "local", path: "C:/skill" }, roles: ["architect"] }), { capability });
  assert.equal((await handlers.capabilities_assign({ kind: "skill", name: "api-review", enabled: false })).capability.enabled, false);
  assert.equal((await handlers.capabilities_base_assign({ agentKey: "architect", tool: "read", enabled: false })).capability.enabled, false);
  assert.deepEqual(await handlers.capabilities_remove({ kind: "skill", name: "api-review" }), { removed: true });

  assert.deepEqual(calls.map(([action]) => action), ["install", "assign", "assignBase", "remove"]);
  assert.deepEqual(recorded.map((event) => event.type), ["capability_installed", "capability_updated", "capability_base_updated", "capability_removed"]);
  assert.ok(recorded.every((event) => event.channel === "desktop"));
});

test("desktop host exposes runtime model selection without restarting the gateway", async () => {
  const calls = [];
  const recorded = [];
  const current = { provider: "openai", model: "gpt-a", thinking: "off", listingProvider: "openai", providers: [], models: [], thinkingLevels: [] };
  const runtimeConfig = {
    get: async (input) => { calls.push(["get", input]); return current; },
    set: async (input) => { calls.push(["set", input]); return { ...current, ...input }; },
  };
  const host = createDesktopHost({
    token: "desktop-session-token-for-tests",
    eventsFile: ".tmp/no-events.jsonl",
    taskStore: { list: async () => [] },
    orchestrator: {},
    runtimeConfig,
    recordEvent: async (event) => recorded.push(event),
  });
  assert.deepEqual(await host.commandHandlers.runtime_config({ provider: "openai" }), current);
  const switched = await host.commandHandlers.runtime_config_set({ provider: "local", model: "coder", thinking: "high" });
  assert.deepEqual(switched, { ...current, provider: "local", model: "coder", thinking: "high" });
  assert.deepEqual(calls, [["get", { provider: "openai" }], ["set", { provider: "local", model: "coder", thinking: "high" }]]);
  assert.deepEqual(recorded, [{ type: "runtime_model_changed", provider: "local", model: "coder", thinking: "high", channel: "desktop" }]);
});

test("desktop host exposes read-only task memory and workspace file projections", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-host-readonly-"));
  const eventsFile = join(dir, "events.jsonl");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(eventsFile, [
    { event_id: "e1", type: "task_created", task_id: "T-1", project_name: "demo", timestamp: "2026-01-01T00:00:01.000Z" },
    { event_id: "e2", type: "file_change", task_id: "T-1:frontend", file_path: "artifacts\\app.tsx", summary: "文件已创建", timestamp: "2026-01-01T00:00:02.000Z" },
    { event_id: "e3", type: "delivery_received", task_id: "T-1:frontend", artifact_paths: ["artifacts/result.md"], artifact_items: [{ path: "artifacts/result.md", description: "验收报告", size: 42 }], timestamp: "2026-01-01T00:00:03.000Z" },
    { event_id: "e4", type: "file_change", task_id: "T-2", project_name: "other", file_path: "artifacts/other.md" },
  ].map(JSON.stringify).join("\n") + "\n");
  const tasks = [
    {
      task_id: "T-1",
      project_name: "demo",
      title: "实现登录",
      conversation_memory: [
        { role: "user", text: "实现登录页", at: "2026-01-01T00:00:01.000Z" },
        { role: "assistant", text: "登录页已完成", at: "2026-01-01T00:00:03.000Z" },
      ],
    },
    { task_id: "T-2", project_name: "other", conversation_memory: [{ role: "user", text: "另一个项目" }] },
  ];
  const host = createDesktopHost({
    token: "desktop-session-token-for-tests",
    eventsFile,
    taskStore: { list: async () => tasks },
    orchestrator: {},
  });

  const memory = await host.commandHandlers.memory_list({ projectName: "demo" });
  assert.deepEqual(memory.items.map((item) => [item.taskId, item.role, item.text]), [
    ["T-1", "assistant", "登录页已完成"],
    ["T-1", "user", "实现登录页"],
  ]);
  const files = await host.commandHandlers.workspace_files({ projectName: "demo" });
  assert.deepEqual(files.files.map((item) => item.path), ["artifacts/result.md", "artifacts/app.tsx"]);
  assert.equal(files.files[0].description, "验收报告");
  assert.equal(files.files[0].size, 42);
  assert.ok(files.files.every((item) => item.projectName === "demo"));
});

test("desktop host edits, confirms and deletes persisted task memory", async () => {
  const task = { task_id: "T-1", conversation_memory: [{ role: "user", text: "旧内容" }, { role: "assistant", text: "保留" }] };
  const calls = [];
  const taskStore = {
    list: async () => [task],
    getRoot: async () => structuredClone(task),
    update: async (id, patch) => { calls.push([id, patch]); Object.assign(task, patch); return task; },
  };
  const host = createDesktopHost({ token: "desktop-session-token-for-tests", eventsFile: ".tmp/no-events.jsonl", taskStore, orchestrator: {} });
  await host.commandHandlers.memory_update({ taskId: "T-1", id: "T-1:0", text: "新内容", confirmed: true });
  assert.equal(calls[0][1].conversation_memory[0].text, "新内容");
  assert.equal(calls[0][1].conversation_memory[0].confirmed, true);
  await host.commandHandlers.memory_delete({ taskId: "T-1", id: "T-1:0" });
  assert.equal(calls[1][1].conversation_memory.length, 1);
});
