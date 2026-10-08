import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createDesktopControlServer } from "../src/desktop-control.js";

const queues = new WeakMap();
function connect(ws, message) {
  let queue = queues.get(ws);
  if (!queue) {
    queue = { messages: [], waiters: [] };
    queues.set(ws, queue);
    ws.on("message", (data) => {
      const value = JSON.parse(data.toString());
      const waiter = queue.waiters.shift();
      if (waiter) waiter(value);
      else queue.messages.push(value);
    });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      queue.waiters = queue.waiters.filter((waiter) => waiter !== resolve);
      reject(new Error("timed out waiting for websocket message"));
    }, 2000);
    const receive = (value) => { clearTimeout(timer); resolve(value); };
    if (queue.messages.length) receive(queue.messages.shift());
    else queue.waiters.push(receive);
    if (message) ws.send(JSON.stringify(message));
  });
}

test("desktop WebSocket requires loopback session token before exposing data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-control-"));
  const eventsFile = join(dir, "events.jsonl");
  await writeFile(eventsFile, `${JSON.stringify({ event_id: "e1", sequence: 1, type: "task_started" })}\n`);
  const token = "desktop-session-token-for-tests";
  const service = createDesktopControlServer({ token, eventsFile, taskStore: { list: async () => [] } });
  const address = await service.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/desktop`);
  await new Promise((resolve) => ws.once("open", resolve));
  ws.send(JSON.stringify({ type: "auth", token: "wrong" }));
  const closed = await new Promise((resolve) => ws.once("close", resolve));
  assert.ok(closed);
  await service.close();
  await rm(dir, { recursive: true, force: true });
});

test("authenticated desktop client receives events after its cursor and commands are token checked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-control-"));
  const eventsFile = join(dir, "events.jsonl");
  await writeFile(eventsFile, [
    { event_id: "e1", sequence: 1, type: "task_started" },
    { event_id: "e2", sequence: 2, type: "agent_started" },
  ].map(JSON.stringify).join("\n") + "\n");
  const commands = [];
  const token = "desktop-session-token-for-tests";
  const service = createDesktopControlServer({ token, eventsFile, taskStore: { list: async () => [] }, commandHandlers: { pause: async (payload) => { commands.push(payload.taskId); return { paused: true }; } } });
  const address = await service.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/desktop`);
  await new Promise((resolve) => ws.once("open", resolve));
  const ready = await connect(ws, { type: "auth", token, cursor: "e1" });
  assert.equal(ready.type, "ready");
  const replay = await connect(ws);
  assert.equal(replay.event.event_id, "e2");
  const reply = await connect(ws, { type: "command", token, command: "pause", taskId: "T-1", requestId: "r1" });
  assert.deepEqual(reply.result, { paused: true });
  assert.deepEqual(commands, ["T-1"]);
  ws.close();
  await service.close();
  await rm(dir, { recursive: true, force: true });
});

test("authenticated desktop client can scope its snapshot and history to one project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-control-"));
  const eventsFile = join(dir, "events.jsonl");
  await writeFile(eventsFile, [
    { event_id: "a1", sequence: 1, type: "task_started", project_name: "alpha" },
    { event_id: "b1", sequence: 2, type: "task_started", project_name: "beta" },
  ].map(JSON.stringify).join("\n") + "\n");
  const token = "desktop-session-token-for-tests";
  const service = createDesktopControlServer({ token, eventsFile, agents: [{ key: "architect" }], taskStore: { list: async () => [{ task_id: "A", project_name: "alpha" }, { task_id: "B", project_name: "beta" }] } });
  const address = await service.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/desktop`);
  await new Promise((resolve) => ws.once("open", resolve));
  const ready = await connect(ws, { type: "auth", token, project: "alpha" });
  assert.deepEqual(ready.tasks.map((task) => task.task_id), ["A"]);
  assert.deepEqual(ready.projects, ["alpha", "beta"]);
  assert.deepEqual(ready.agents, [{ key: "architect" }]);
  const event = await connect(ws);
  assert.equal(event.event.project_name, "alpha");
  service.publish({ event_id: "live-beta", type: "task_started", project_name: "beta" });
  service.publish({ event_id: "live-alpha", type: "task_started", project_name: "alpha" });
  const live = await connect(ws);
  assert.equal(live.event.event_id, "live-alpha");
  ws.close();
  await service.close();
  await rm(dir, { recursive: true, force: true });
});

test("project-scoped desktop clients cannot submit, export or control another project", async () => {
  const token = "desktop-session-token-for-tests";
  const commands = [];
  const service = createDesktopControlServer({
    token,
    taskStore: { list: async () => [{ task_id: "A", project_name: "alpha" }, { task_id: "B", project_name: "beta" }] },
    commandHandlers: { submit_task: async (payload) => { commands.push(payload); return { accepted: true }; }, pause: async () => ({ paused: true }), export_project: async () => ({ exported: true }) },
  });
  const address = await service.listen(); const ws = new WebSocket(`ws://127.0.0.1:${address.port}/desktop`); await new Promise((resolve) => ws.once("open", resolve));
  await connect(ws, { type: "auth", token, project: "alpha" });
  const rejectedSubmit = await connect(ws, { type: "command", token, command: "submit_task", projectName: "beta", description: "x" });
  assert.match(rejectedSubmit.error, /project scope/);
  const rejectedExport = await connect(ws, { type: "command", token, command: "export_project", projectName: "beta" });
  assert.match(rejectedExport.error, /project scope/);
  const rejectedPause = await connect(ws, { type: "command", token, command: "pause", taskId: "B" });
  assert.match(rejectedPause.error, /project scope/);
  assert.equal(commands.length, 0);
  ws.close(); await service.close();
});
