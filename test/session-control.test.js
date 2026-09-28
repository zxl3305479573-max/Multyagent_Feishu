import test from "node:test";
import assert from "node:assert/strict";
import { abortActiveSessions, registerActiveSession, resetSessionControlForTest } from "../src/session-control.js";

test.beforeEach(() => resetSessionControlForTest());
test.afterEach(() => resetSessionControlForTest());

test("termination aborts every active root and subtask session exactly once", async () => {
  const aborted = [];
  const makeSession = (id) => ({ abort: async () => aborted.push(id) });
  registerActiveSession("T-1:architect", makeSession("architect"));
  registerActiveSession("T-1:tester", makeSession("tester"));
  const count = await abortActiveSessions("T-1");
  await abortActiveSessions("T-1");
  assert.equal(count, 2);
  assert.deepEqual(aborted.sort(), ["architect", "tester"]);
});

test("unregistered sessions are not aborted and a late session is immediately aborted", async () => {
  let aborts = 0;
  const unregister = registerActiveSession("T-2", { abort: async () => { aborts += 1; } });
  unregister();
  await abortActiveSessions("T-2");
  registerActiveSession("T-2:backend", { abort: async () => { aborts += 1; } });
  await Promise.resolve();
  assert.equal(aborts, 1);
});
