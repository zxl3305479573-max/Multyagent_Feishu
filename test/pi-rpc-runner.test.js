import test from "node:test";
import assert from "node:assert/strict";
import { PiRpcRunner } from "../src/runtime/pi-rpc-runner.js";

function fakeChild(lines, { code = 0, signal = null } = {}) {
  const listeners = new Map();
  const child = {
    stdin: { write() {} },
    stdout: null,
    stderr: { on() {} },
    once(type, fn) { listeners.set(type, fn); return child; },
    kill() {},
  };
  child.stdout = { on(type, fn) { if (type === "data") for (const line of lines) fn(Buffer.from(`${line}\n`)); } };
  queueMicrotask(() => listeners.get("exit")?.(code, signal));
  return child;
}

test("Pi RPC waits for agent_settled and returns streamed text", async () => {
  const runner = new PiRpcRunner({
    spawn: () => fakeChild([
      JSON.stringify({ type: "turn_end" }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }),
      JSON.stringify({ type: "agent_settled" }),
    ]),
  });
  const result = await runner.run("hello", { timeoutMs: 100 });
  assert.equal(result.text, "done");
  assert.equal(result.events.at(-1).type, "agent_settled");
});

test("Pi RPC rejects a process that exits before agent_settled", async () => {
  const runner = new PiRpcRunner({ spawn: () => fakeChild([JSON.stringify({ type: "turn_end" })], { code: 2 }) });
  await assert.rejects(() => runner.run("hello", { timeoutMs: 100 }), /before agent_settled/);
});
