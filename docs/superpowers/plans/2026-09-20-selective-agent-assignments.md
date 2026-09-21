# Selective Agent Assignments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the project manager explicitly choose all participating roles and show that assignment list in the Feishu reply.

**Architecture:** Add an optional `assignments` array to the delivery protocol. The project manager must use it for planning; the orchestrator treats it as an allow-list for the root task and keeps existing dependency barriers for selected roles. Result cards render the normalized assignment list.

**Tech Stack:** Node.js ES modules, built-in `node:test`, Feishu interactive cards.

---

### Task 1: Extend delivery data and project-manager instructions

**Files:**
- Modify: `src/pi-agent.js`
- Test: `test/pi-agent.test.js`

- [ ] Add `assignments` as an optional array of `{ agentKey, task, reason }` to `deliver_artifact`.
- [ ] Normalize and persist assignment entries, and instruct the project manager to include only required roles.
- [ ] Add a test asserting the project-manager system prompt requires selective assignments.

### Task 2: Filter orchestration by project-manager assignments

**Files:**
- Modify: `src/orchestrator.js`
- Test: `test/orchestrator.test.js`

- [ ] Build a root-task assignment allow-list from the project-manager delivery.
- [ ] Skip route targets not present in the allow-list; if the list is absent, do not dispatch the root task.
- [ ] Preserve existing `all_done`, approval, pause, and max-round behavior for selected roles.
- [ ] Add tests for selected-only dispatch and missing-assignment no-op.

### Task 3: Show assignments in Feishu replies

**Files:**
- Modify: `src/gateway.js`
- Test: `test/reply.test.js`

- [ ] Normalize assignment objects alongside existing delivery fields.
- [ ] Render a `任务分配` section containing role, task, and optional reason.
- [ ] Verify malformed assignment entries are ignored and valid entries appear in the card.

### Task 4: Verify

- [ ] Run `npm test`.
- [ ] Confirm all existing tests plus the new selective-dispatch and card-format tests pass.
