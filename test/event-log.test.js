import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forEachEvent, readEventsTail, rotateEventLog } from "../src/event-log.js";

function fixture(count, extra = (i) => ({})) {
  const dir = mkdtempSync(join(tmpdir(), "event-log-"));
  const file = join(dir, "events.jsonl");
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ event_id: `e${i}`, task_id: `T-${i % 3}`, n: i, ...extra(i) }));
  writeFileSync(file, `${lines.join("\n")}\nnot json\n`);
  return { dir, file };
}

test("tail read returns the newest events in order across chunk boundaries", async () => {
  const { dir, file } = fixture(500);
  try {
    const { events } = await readEventsTail(file, { limit: 7, chunkSize: 64 });
    assert.deepEqual(events.map((e) => e.n), [493, 494, 495, 496, 497, 498, 499]);
    const filtered = await readEventsTail(file, { limit: 3, filter: (e) => e.task_id === "T-0", chunkSize: 100 });
    assert.deepEqual(filtered.events.map((e) => e.n), [492, 495, 498]);
    const all = await readEventsTail(file, { limit: 10_000, chunkSize: 128 });
    assert.equal(all.events.length, 500);
    assert.equal(all.events[0].n, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tail read resumes after a cursor and reports unknown cursors", async () => {
  const { dir, file } = fixture(3000);
  try {
    const after = await readEventsTail(file, { limit: 5, cursor: "e10", chunkSize: 512 });
    assert.equal(after.cursorFound, true);
    assert.deepEqual(after.events.map((e) => e.n), [11, 12, 13, 14, 15]);
    const near = await readEventsTail(file, { limit: 1000, cursor: "e2997" });
    assert.deepEqual(near.events.map((e) => e.n), [2998, 2999]);
    const missing = await readEventsTail(file, { limit: 4, cursor: "nope" });
    assert.equal(missing.cursorFound, false);
    assert.deepEqual(missing.events.map((e) => e.n), [2996, 2997, 2998, 2999]);
    assert.deepEqual((await readEventsTail(join(dir, "none.jsonl"))).events, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("streaming reader skips malformed lines", async () => {
  const { dir, file } = fixture(50);
  try {
    let count = 0;
    assert.equal(await forEachEvent(file, () => { count += 1; }), 50);
    assert.equal(count, 50);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rotation archives large logs and carries events of active tasks", async () => {
  const { dir, file } = fixture(300);
  try {
    assert.equal((await rotateEventLog({ file, maxBytes: 10 * 1024 * 1024 })).rotated, false);
    const result = await rotateEventLog({ file, maxBytes: 100, keepTask: (root) => root === "T-1" });
    assert.equal(result.rotated, true);
    assert.equal(result.carried, 100);
    const kept = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(kept.every((e) => e.task_id === "T-1"), true);
    assert.equal(readdirSync(join(dir, "events-archive")).length, 1);
    assert.match(readFileSync(result.archiveFile, "utf8"), /"e299"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
