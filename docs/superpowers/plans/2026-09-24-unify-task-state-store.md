# Unify Task State Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `src/domain/task-store.js` the single durable source of task state while preserving the existing `src/tasks.js` API used by the gateway, orchestrator, and Pi runner.

**Architecture:** Add a compatibility facade in `src/tasks.js` backed by one configurable `TaskStore` instance. Map legacy camelCase fields and root-task semantics at the facade boundary, while all persistence, status transitions, pause/terminate flags, idempotency, and leases remain in the domain store. Keep existing callers unchanged in this phase.

**Tech Stack:** Node.js ESM, `node:test`, JSON file persistence.

---

### Task 1: Define the unified state contract with failing tests

**Files:**
- Modify: `test/task-store.test.js`
- Modify: `test/tasks.test.js`
- Create: `test/unified-task-state.test.js`

- [x] **Step 1: Add tests proving the facade persists into the domain store file.**

```js
test("legacy task facade and TaskStore observe the same task", async () => {
  const task = await createTask({ agentKey: "backend_developer", chatId: "chat-1", rootKey: "thread-1", messageId: "m-1" });
  const store = new TaskStore(FILE);
  const record = await store.get(task.taskId);
  assert.equal(record.agent, "backend_developer");
  assert.equal(record.source_chat_id, "chat-1");
});
```

- [x] **Step 2: Add tests for unified pause and termination state.**

```js
test("pause and terminate are represented in the domain task record", async () => {
  const task = await createTask({ agentKey: "backend_developer", chatId: "chat-1", messageId: "m-1" });
  await setPaused(task.taskId, true);
  assert.equal((await new TaskStore(FILE).get(task.taskId)).paused, true);
  await setTerminated(task.taskId, true);
  const record = await new TaskStore(FILE).get(task.taskId);
  assert.equal(record.terminated, true);
  assert.equal(record.paused, false);
});
```

- [x] **Step 3: Run the focused tests and confirm they fail for the current split storage.**

Run: `node --test test/unified-task-state.test.js`

Expected: FAIL because the legacy facade writes `runtime/tasks*.json` instead of the `TaskStore` file.

### Task 2: Extend the domain TaskStore for legacy lifecycle fields

**Files:**
- Modify: `src/domain/task.js`
- Modify: `src/domain/task-store.js`
- Test: `test/task-store.test.js`

- [x] **Step 1: Add a domain-store test for pause/termination updates and root lookup.**

```js
test("domain store updates control flags and resolves child task roots", async () => {
  const store = new TaskStore(FILE);
  const root = await store.create({ task_id: "root", project_id: "p", status: "received" });
  await store.create({ task_id: "root:backend_developer", parent_task_id: root.task_id, status: "running" });
  await store.setPaused(root.task_id, true);
  await store.setTerminated(root.task_id, true);
  assert.equal((await store.get("root")).paused, false);
  assert.equal((await store.get("root")).terminated, true);
  assert.equal((await store.getRoot("root:backend_developer")).task_id, "root");
});
```

- [x] **Step 2: Run the test and verify the new methods are missing.**

Run: `node --test test/task-store.test.js`

Expected: FAIL with missing `setPaused`, `setTerminated`, or `getRoot`.

- [x] **Step 3: Implement minimal domain methods.**

Add `paused` and `terminated` defaults to `createTaskRecord`, plus `getRoot(taskId)`, `setPaused(taskId, paused)`, and `setTerminated(taskId, terminated)` in `TaskStore`. `setTerminated(true)` must clear `paused`; all updates must use the existing serialized `persist()` chain.

- [x] **Step 4: Run the focused domain tests.**

Run: `node --test test/task-store.test.js`

Expected: PASS.

### Task 3: Replace the legacy persistence implementation with a compatibility facade

**Files:**
- Modify: `src/tasks.js`
- Modify: `src/index.js`
- Modify: `test/tasks.test.js`
- Modify: `test/gateway.test.js`
- Modify: `test/orchestrator.test.js`

- [x] **Step 1: Add a test that `_resetForTest()` selects the same file for both APIs.**

```js
test("test reset configures the unified store file", async () => {
  const task = await createTask({ agentKey: "tester", chatId: "chat", messageId: "m" });
  assert.equal((await new TaskStore(TEST_FILE).get(task.taskId)).task_id, task.taskId);
});
```

- [x] **Step 2: Run the test and confirm it fails before the facade rewrite.**

Run: `node --test test/tasks.test.js`

Expected: FAIL because the task is not present in `TaskStore(TEST_FILE)`.

- [x] **Step 3: Implement the facade.**

Keep exported functions (`createTask`, `updateTask`, `findTaskByRoot`, `findRecentTask`, `linkRootAlias`, `setPaused`, `isPaused`, `setTerminated`, `isTerminated`, `_resetForTest`) but delegate persistence to a `TaskStore`. Translate legacy fields at the boundary (`taskId` ↔ `task_id`, `chatId` ↔ `source_chat_id`, `agentKey` ↔ `agent`, `updatedAt` ↔ `updated_at`). Store root aliases in the domain record or a small `aliases` index in the same JSON file; do not create a second task file.

- [x] **Step 4: Update application construction to use one configured file.**

In `src/index.js`, construct the domain store with `PI_TASKS_FILE` when no explicit domain file is supplied, or pass the same store instance into the facade initialization hook. Remove the separate `PI_DOMAIN_TASKS_FILE` default once compatibility tests pass.

- [x] **Step 5: Run all existing task, gateway, and orchestrator tests.**

Run: `node --test test/tasks.test.js test/task-store.test.js test/gateway.test.js test/orchestrator.test.js`

Expected: PASS with no writes to a second task-state file.

### Task 4: Enforce state transitions for control actions

**Files:**
- Modify: `src/tasks.js`
- Modify: `src/domain/task-store.js`
- Modify: `test/tasks.test.js`

- [x] **Step 1: Add tests for control-state transitions.**

Verify that pausing a running task records `blocked` or an explicit `paused` control flag without losing the lifecycle status, termination is terminal, and a terminated task cannot be resumed.

- [x] **Step 2: Run the tests and confirm the current facade allows unrestricted patches.**

Run: `node --test test/tasks.test.js`

Expected: FAIL on the new transition assertions.

- [x] **Step 3: Implement the smallest compatible rule set.**

Keep `paused` and `terminated` as orthogonal control flags for compatibility, but route lifecycle changes through `TaskStore.transition()`. Reject updates that attempt to move a terminal task back to an active state. Preserve existing `isPaused()` and `isTerminated()` behavior for child task IDs by resolving their root.

- [x] **Step 4: Run the full test suite.**

Run: `npm test`

Expected: PASS.

### Task 5: Document the single-source-of-truth contract

**Files:**
- Modify: `README.md`
- Modify: `docs/overview.md`

- [x] **Step 1: Document the canonical file, fields, and compatibility API.**

State that `TaskStore` owns task persistence and lifecycle; `src/tasks.js` is only a compatibility facade for gateway/orchestrator callers. Document the configured environment variable and migration behavior for existing `runtime/tasks.json` data.

- [x] **Step 2: Run the complete verification command.**

Run: `npm test`

Expected: exit code 0 and all tests passing.
