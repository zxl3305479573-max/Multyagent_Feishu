# Bitable Task Control Plane And Trace Implementation Plan

> **For agentic workers:** Execute inline task-by-task with test-first checkpoints. Preserve the existing dirty worktree and additive-only Bitable setup.

**Goal:** Add Bitable task progress/control and a separate structured execution Trace table, with pause/resume/terminate behavior that is persisted and safe to retry.

**Architecture:** Keep the gateway and its JSONL event log authoritative. Add pure trace sanitization/projection, isolated Bitable trace and command-poller adapters, persisted task-control state, and a Pi session registry that can abort all active sessions for a root task. Wire all Bitable access through the project-manager app only.

**Tech Stack:** Node 22 ESM, `node:test`, `@larksuiteoapi/node-sdk`, Pi `AgentSession` SDK.

---

## File Structure

- Modify `src/domain/bitable-board.js`: add board fields and deterministic task/agent/progress reduction.
- Create `src/domain/trace.js`: trace schema, safe event projection, and credential redaction.
- Create `src/bitable-trace-sync.js`: idempotent append/update projection into the configured Trace table.
- Create `src/bitable-control.js`: paginated board polling, exact command parsing, callback dispatch, and command-cell acknowledgement.
- Modify `src/tasks.js`: persist pause and termination flags and expose idempotent transitions.
- Create `src/session-control.js`: register active Pi sessions by root task and abort them on termination.
- Modify `src/pi-agent.js`: emit safe tool lifecycle events and register/unregister sessions.
- Modify `src/orchestrator.js`: track progress/active agents, checkpoint paused deliveries, resume checkpoints, and refuse dispatch after termination.
- Modify `src/gateway.js`: pass structured event callbacks into root Agent runs and report terminated tasks distinctly.
- Modify `src/index.js`: resolve Bitable only with the project-manager client; wire board, trace, and poller independently and fail-open.
- Modify `.env.example`, `README.md`, and the design spec: document optional Trace table ID, poll interval, fields, privacy, and one-shot commands.
- Create `test/trace.test.js`, `test/bitable-trace-sync.test.js`, `test/bitable-control.test.js`, and `test/session-control.test.js`; extend existing board, task, Pi, orchestrator, and Bitable tests.

## Task 1: Board Projection And Trace Sanitizer

**Files:** Modify `src/domain/bitable-board.js`; create `src/domain/trace.js`; test `test/bitable-board.test.js`, `test/trace.test.js`.

- [ ] Write tests asserting board schema contains the progress, active-agent, control-command, and control-result columns, while `toBitableFields` never returns `控制指令`.
- [ ] Write tests asserting planned/completed/active agent events produce clamped integer progress, current action, and active-agent summary; terminal completion produces 100 percent and failure does not invent progress.
- [ ] Write trace tests asserting full prompt/text/content fields and model reasoning are excluded, event IDs and task/agent/state/tool fields are preserved, and API keys/Bearer/password assignments are redacted from commands and errors.
- [ ] Run `node --test test/bitable-board.test.js test/trace.test.js`; confirm new assertions fail because the fields/projection are absent.
- [ ] Implement only the pure schema/reducer and trace normalization functions needed by those tests.
- [ ] Re-run the same test command; confirm all new and existing focused tests pass.

## Task 2: Trace Table Projector

**Files:** Create `src/bitable-trace-sync.js`; create `test/bitable-trace-sync.test.js`.

- [ ] Write fake-client tests asserting an event creates one trace record, a repeated event ID updates the same record, stale mappings recover by searching `事件编号`, and API failures are swallowed and retried.
- [ ] Run `node --test test/bitable-trace-sync.test.js`; confirm the module/export is missing.
- [ ] Implement an additive-only trace field reconciler and a serialized flush queue using the same SDK response handling conventions as `src/bitable-sync.js`.
- [ ] Persist `event_id -> record_id` mappings and replay the JSONL log without copying prompt text or tool output.
- [ ] Re-run `node --test test/bitable-trace-sync.test.js`; confirm idempotency and failure-isolation tests pass.

## Task 3: Durable Task Controls And Session Abort

**Files:** Modify `src/tasks.js`; create `src/session-control.js`; create `test/session-control.test.js`; extend `test/gateway.test.js` and `test/orchestrator.test.js`.

- [ ] Write tests asserting task pause/resume/termination state persists and termination cannot be cleared by a resume command.
- [ ] Write registry tests asserting root IDs include all matching sessions, `abort()` is awaited once per active session, and unregistering a completed session prevents later abort calls.
- [ ] Write orchestrator tests asserting a delivery received while paused is checkpointed, resuming dispatches it exactly once, and terminated tasks never dispatch again.
- [ ] Run the focused tests and confirm the missing APIs/behavior fail.
- [ ] Implement persistence and a configurable checkpoint file; restore checkpoints at orchestrator startup.
- [ ] Pass pause/termination guards through every dispatch path and emit structured control, hold, and cancellation events.
- [ ] Re-run the focused tests and confirm the pause/resume/terminate flow passes.

## Task 4: Bitable Command Poller

**Files:** Create `src/bitable-control.js`; create `test/bitable-control.test.js`.

- [ ] Write tests asserting only exact `暂停`, `继续`, and `终止` values are accepted; text/array cell representations normalize; unknown commands are not cleared.
- [ ] Write paginated fake-client tests asserting every command-bearing record is processed sequentially, callback failure leaves the command intact, and success clears only `控制指令` while preserving all other fields.
- [ ] Run `node --test test/bitable-control.test.js`; confirm missing behavior fails.
- [ ] Implement a non-overlapping poll loop with an injectable interval, callback, logger, and timer; do not let one record/API error stop later records or the gateway.
- [ ] Re-run `node --test test/bitable-control.test.js`; confirm parsing, pagination, retry, and acknowledgement behavior pass.

## Task 5: Pi Tool Trace And Cancellation

**Files:** Modify `src/pi-agent.js`; extend `test/pi-agent.test.js` and `test/session-control.test.js`.

- [ ] Write a testable tool-event mapper asserting `bash`/PowerShell calls emit redacted command metadata, successful write/edit tools emit file-change paths, test commands emit pass/fail events, and full results are never logged.
- [ ] Run the focused tests and confirm the event mapper is missing.
- [ ] Add the mapper to `tool_execution_start`/`tool_execution_end` subscriptions, emit agent start/end/error events through `context.onEvent`, and register Pi sessions under root task IDs.
- [ ] On termination, abort the active session and surface a typed cancellation result so the gateway does not report an ordinary failure or schedule more work.
- [ ] Re-run focused Pi/session tests; confirm tool metadata redaction and session abort pass.

## Task 6: Gateway Wiring, Progress, And Configuration

**Files:** Modify `src/orchestrator.js`, `src/gateway.js`, `src/index.js`, `src/domain/bitable-board.js`, `.env.example`, `README.md`, and the design spec; extend existing Bitable/orchestrator tests.

- [ ] Write wiring tests asserting board, trace, and control sinks receive events independently; absent trace config or a Bitable 403 disables only the affected integration; no non-project-manager client is used.
- [ ] Write tests asserting progress events are emitted from known plan/completion counts and control updates project concise outcomes to the board.
- [ ] Run focused tests and confirm the new configuration/wiring behavior fails.
- [ ] Pass `onEvent` into every root and downstream Agent context; emit plan/dispatch completion/active-agent events; remove a completed role from active status.
- [ ] Resolve Bitable with `prepared.find(project_manager)` only; reconcile board and optional trace schemas additively; wire poller and trace projector separately.
- [ ] Add `FEISHU_BITABLE_TRACE_TABLE_ID`, `FEISHU_BITABLE_CONTROL_POLL_MS`, and trace mapping configuration to docs without exposing credentials.
- [ ] Run the focused integration suites and confirm fail-open behavior, progress, and PM-only access pass.

## Task 7: Final Verification

**Files:** No additional production changes unless a test exposes a defect.

- [ ] Run `npm test` and confirm every suite passes.
- [ ] Run `git diff --check` and inspect `git status --short` to ensure only this feature's intended additive changes were made and all pre-existing edits remain untouched.
- [ ] Check whether local Bitable credentials and Trace table configuration are available without printing secret values; if available, run only read/setup-safe diagnostics, never `scripts/setup-bitable-board.mjs`.
- [ ] Report local test results separately from live Bitable permission/configuration results.
