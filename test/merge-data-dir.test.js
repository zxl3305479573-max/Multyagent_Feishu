import test from "node:test";
import assert from "node:assert/strict";
import { mergeEventLists, mergeTaskStates } from "../scripts/merge-data-dir.mjs";

test("merging task stores keeps the newer copy of a shared task and target indexes win", () => {
  const source = { tasks: { A: { task_id: "A", updated_at: "2026-10-02" }, B: { task_id: "B", updated_at: "2026-09-01" } }, byIdempotencyKey: { k: "A" }, aliases: {}, recent: { r: "A" } };
  const target = { tasks: { B: { task_id: "B", updated_at: "2026-10-01" } }, byIdempotencyKey: {}, aliases: {}, recent: { r: "B" } };
  const { merged, added, updated } = mergeTaskStates(source, target);
  assert.equal(added, 1);
  assert.equal(updated, 0);
  assert.equal(merged.tasks.B.updated_at, "2026-10-01");
  assert.equal(merged.byIdempotencyKey.k, "A");
  assert.equal(merged.recent.r, "B");
});

test("merging event logs dedupes by event id and orders by time", () => {
  const source = [{ event_id: "s1", timestamp: "2026-10-01T00:00:00Z" }, { event_id: "t1", timestamp: "2026-10-03T00:00:00Z" }];
  const target = [{ event_id: "t1", timestamp: "2026-10-03T00:00:00Z" }, { event_id: "t2", timestamp: "2026-10-02T00:00:00Z" }];
  const { merged, added } = mergeEventLists(source, target);
  assert.equal(added, 1);
  assert.deepEqual(merged.map((event) => event.event_id), ["s1", "t2", "t1"]);
});

test("re-running the merge does not duplicate legacy events without an event id", () => {
  const legacy = { type: "task_started", task_id: "OLD", timestamp: "2026-09-01T00:00:00Z" };
  const first = mergeEventLists([legacy], []);
  const second = mergeEventLists([{ ...legacy }], first.merged);
  assert.equal(second.added, 0);
  assert.equal(second.merged.length, 1);
});
