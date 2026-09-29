# Feishu Bitable Task Board Implementation Plan

> **For agentic workers:** Execute the tasks in order. Each task is test-first.

**Goal:** Project gateway task lifecycle into a Wiki-hosted Feishu Bitable table as a one-way dashboard without changing task execution semantics.

**Architecture:** A pure reducer derives a per-root-task board state from the existing structured event stream. A sync service resolves the Wiki node to its Bitable object token, reconciles the additive field schema, then creates or updates one record per root task. All failures are logged and swallowed so agents, approvals, and dispatch are unaffected.

**Tech Stack:** Node 22 ESM, `node:test`, `@larksuiteoapi/node-sdk` bitable/wiki v1+v2.

---

## File Structure

- `src/domain/bitable-board.js` — pure logic: root task id, event reducer, Bitable field payload. No SDK, no filesystem.
- `src/bitable-sync.js` — SDK-facing: Wiki token resolution, field reconciliation, record mapping persistence, queued create/update.
- `test/bitable-board.test.js` — unit tests for the pure logic.
- `test/bitable-sync.test.js` — unit tests for sync behaviour using a fake client.
- `src/index.js` — construct the sync service and fan gateway events into it.
- `src/gateway.js` — carry the user instruction text on `task_created` / `task_reused` so the board row has a title.
- `.env.example`, `README.md` — document `FEISHU_BITABLE_WIKI_TOKEN`.

---

### Task 1: Board state reducer

**Files:** Create `src/domain/bitable-board.js`, `test/bitable-board.test.js`

- Step 1: Write failing test asserting `rootTaskIdFor({task_id:"T:architect"}) === "T"`, `rootTaskIdFor({type:"message_received"}) === null`, and that `reduceEvent` maps `task_started` → `status:"in_progress"`, `dispatch_started` → `owner_agent: target`, `approval_required` → `status:"awaiting_approval"`, `delivery_received` → `blockers/risks/output_artifacts`, `task_settle` → `status:"completed"` plus `completed_at`, `task_failed`/`dispatch_failed` → `status:"failed"`.
- Step 2: Run `node --test test/bitable-board.test.js` — expect failure, module not found.
- Step 3: Implement `initialBoardState(taskId)`, `rootTaskIdFor(event)`, `reduceEvent(state, event)`.
- Step 4: Re-run — expect pass.

### Task 2: Bitable field payload

**Files:** Modify `src/domain/bitable-board.js`, `test/bitable-board.test.js`

- Step 1: Write failing test asserting `toBitableFields` joins `blockers`/`risks`/artifact arrays with newline, converts ISO timestamps to epoch milliseconds for the DateTime fields, keeps `progress`/`attempt` numeric, and omits null timestamps.
- Step 2: Run the test — expect failure.
- Step 3: Export `BOARD_FIELD_SCHEMA` describing each logical field (`name`, Feishu `type`, `ui_type`) and implement `toBitableFields(state)`.
- Step 4: Re-run — expect pass.

### Task 3: Wiki token resolution and field reconciliation

**Files:** Create `src/bitable-sync.js`, `test/bitable-sync.test.js`

- Step 1: Write failing test with a fake client: `resolveBitableTarget` prefers an explicit `appToken`, otherwise calls `wiki.v2.space.getNode` and uses `data.node.obj_token`, throwing when the node is not a `bitable`.
- Step 2: Write failing test asserting `reconcileFields` creates only the missing fields, is a no-op when the schema is complete, and does nothing when `autoInit` is false.
- Step 3: Run `node --test test/bitable-sync.test.js` — expect failure.
- Step 4: Implement both functions.
- Step 5: Re-run — expect pass.

### Task 4: Idempotent record projection

**Files:** Modify `src/bitable-sync.js`, `test/bitable-sync.test.js`

- Step 1: Write failing tests asserting: first event creates a record and persists the mapping; a later event updates the same `record_id`; a stale `record_id` triggers a search by `task_id` and retries the update; a failing create is logged and does not reject.
- Step 2: Run the test — expect failure.
- Step 3: Implement `createBitableSync({client, appToken, tableId, storageFile, log, flushDelayMs})` returning `{handleEvent, whenIdle, flush, stats}` with a debounced sequential flush queue.
- Step 4: Re-run — expect pass.

### Task 5: Gateway wiring

**Files:** Modify `src/index.js`, `src/gateway.js`, `test/bitable-sync.test.js`

- Step 1: Write failing test asserting the event fan-out forwards an event to the sync service and keeps working when the sync service throws.
- Step 2: Run the test — expect failure.
- Step 3: Add `text` to `task_created`/`task_reused` in `gateway.js`; construct the sync service in `index.js` from `FEISHU_BITABLE_*` env vars, resolve the target from the project-manager client, reconcile fields, and forward every `onEvent` occurrence.
- Step 4: Run `npm test` — expect all suites pass.

### Task 6: Configuration and docs

**Files:** Modify `.env.example`, `README.md`, `docs/superpowers/specs/2026-09-22-bitable-task-board-design.md`

- Step 1: Add `FEISHU_BITABLE_WIKI_TOKEN`, `FEISHU_BITABLE_AUTO_INIT`, and `FEISHU_BITABLE_RECORDS_FILE` to `.env.example`.
- Step 2: Document board setup, the additive field policy, and troubleshooting in `README.md`.
- Step 3: Correct the spec: startup performs additive-only field reconciliation so the confirmed "自动校验或创建所需字段" behaviour matches the document.

### Task 7: Live verification

**Files:** Modify `scripts/check-bitable.mjs`

- Step 1: Extend the script to accept a Wiki node token and resolve it before listing fields.
- Step 2: Run `node scripts/check-bitable.mjs` and confirm the field list contains the board schema.
- Step 3: Run the projector against the live table with a synthetic smoke task, confirm one record is created and updated in place.

---

## Status (2026-09-22)

- Tasks 1-6: complete. `npm test` passes 177/177.
- Task 7 Step 1-2: the Wiki node resolves to `bascn`-style token and the
  read-only check passes.
- Task 7 Step 3: blocked on an external permission. The app can read the table
  (`appTableField.list` succeeds) but every write (`appTableRecord.create`,
  `appTableField.create`) returns HTTP 403 / code `91403 Forbidden`. The app
  must be an editable collaborator of the Wiki-hosted table and the
  `bitable:app` scope must be published. Re-run
  `node scripts/smoke-bitable.mjs` once that is fixed.
- `runtime/probe-bitable.mjs` is a throwaway diagnostic; it could not be
  deleted because the sandbox blocks `Remove-Item`. `runtime/` is gitignored.
