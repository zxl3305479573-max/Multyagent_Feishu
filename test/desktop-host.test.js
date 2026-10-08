import test from "node:test";
import assert from "node:assert/strict";
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
      retry: async (id, error) => { calls.push(["retry", id, error]); return { task_id: id, status: "retrying", attempt: 2 }; },
    },
    orchestrator: { resumeTask: async (id) => { calls.push(["resume", id]); return 1; } },
    recordEvent: async (event) => recorded.push(event),
  });

  assert.deepEqual(await host.commandHandlers.retry({ taskId: "T-2", error: "tool timeout" }), { retried: true, resumed: 1, attempt: 2 });
  assert.deepEqual(calls, [["retry", "T-2", "tool timeout"], ["resume", "T-2"]]);
  assert.deepEqual(recorded, [{ type: "control_applied", task_id: "T-2", command: "retry", result: "retrying" }]);
});

test("desktop host exposes task submission as a command", async () => {
  const submitted = [];
  const host = createDesktopHost({
    token: "desktop-session-token-for-tests",
    eventsFile: ".tmp/no-events.jsonl",
    taskStore: { list: async () => [] },
    orchestrator: {},
    submitTask: async (input) => { submitted.push(input); return { taskId: "TASK-1", status: "accepted" }; },
  });
  assert.deepEqual(await host.commandHandlers.submit_task({ projectName: "demo", title: "标题", description: "描述" }), { taskId: "TASK-1", status: "accepted" });
  assert.deepEqual(submitted, [{ projectName: "demo", title: "标题", description: "描述" }]);
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
