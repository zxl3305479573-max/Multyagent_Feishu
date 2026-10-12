import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createShutdown } from "../src/shutdown.js";

const quiet = { info() {}, warn() {}, error() {} };

test("shutdown runs registered steps in reverse order and exits once", async () => {
  const order = [];
  const exits = [];
  const lifecycle = createShutdown({ log: quiet, exit: (code) => exits.push(code) });
  lifecycle.register("lock", () => order.push("lock"));
  lifecycle.register("store", async () => { await new Promise((r) => setTimeout(r, 5)); order.push("store"); });
  lifecycle.register("ws", () => order.push("ws"));
  await Promise.all([lifecycle.shutdown("test"), lifecycle.shutdown("again")]);
  assert.deepEqual(order, ["ws", "store", "lock"]);
  assert.deepEqual(exits, [0]);
});

test("a failing or hanging step does not block the remaining steps", async () => {
  const order = [];
  const lifecycle = createShutdown({ log: quiet, timeoutMs: 2000, exit: () => {} });
  lifecycle.register("lock", () => order.push("lock"));
  lifecycle.register("hang", () => new Promise(() => {}));
  lifecycle.register("boom", () => { throw new Error("boom"); });
  await lifecycle.shutdown("test");
  assert.deepEqual(order, ["lock"]);
});

test("signal and IPC messages trigger shutdown", async () => {
  const target = new EventEmitter();
  let exited = 0;
  const lifecycle = createShutdown({ log: quiet, exit: () => { exited += 1; } });
  lifecycle.installSignalHandlers(target);
  target.emit("message", { type: "shutdown" });
  target.emit("SIGINT");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(exited, 1);
});

test("an IPC-connected gateway shuts down when its parent disconnects", async () => {
  const target = new EventEmitter();
  target.connected = true;
  let exited = 0;
  const lifecycle = createShutdown({ log: quiet, exit: () => { exited += 1; } });
  lifecycle.installSignalHandlers(target);
  target.emit("disconnect");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(exited, 1);
});
