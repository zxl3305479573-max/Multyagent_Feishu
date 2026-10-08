import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportProjectSnapshot, archiveProjectHistory, restoreProjectHistory } from "../src/project-history.js";

test("project history export keeps only the selected project's tasks, events and artifact references", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-history-"));
  try {
    const eventsFile = join(root, "events.jsonl");
    await writeFile(eventsFile, [
      { event_id: "a", type: "task_created", task_id: "T-a", project_name: "alpha", artifact_paths: ["workspace/alpha/artifacts/a.md"] },
      { event_id: "b", type: "task_created", task_id: "T-b", project_name: "beta", artifact_paths: ["workspace/beta/artifacts/b.md"] },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    const taskStore = { list: async () => [
      { task_id: "T-a", project_name: "alpha", title: "Alpha", status: "completed" },
      { task_id: "T-b", project_name: "beta", title: "Beta", status: "running" },
    ] };
    const output = join(root, "export.json");
    const snapshot = await exportProjectSnapshot({ project: "alpha", taskStore, eventsFile, outputFile: output });
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.events.length, 1);
    assert.deepEqual(snapshot.artifact_refs, ["workspace/alpha/artifacts/a.md"]);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), snapshot);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project history cleanup archives old project events and keeps the newest entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-history-cleanup-"));
  try {
    const eventsFile = join(root, "events.jsonl"); const archiveFile = join(root, "archive.jsonl");
    const records = Array.from({ length: 3 }, (_, index) => ({ event_id: `a-${index}`, type: "trace", project_name: "alpha", sequence: index }));
    records.push({ event_id: "b-0", type: "trace", project_name: "beta" });
    await writeFile(eventsFile, records.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const result = await archiveProjectHistory({ project: "alpha", eventsFile, archiveFile, keep: 1 });
    assert.equal(result.archived, 2);
    assert.equal(result.kept, 1);
    const current = (await readFile(eventsFile, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(current.map((event) => event.event_id), ["a-2", "b-0"]);
    const archived = (await readFile(archiveFile, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(archived.map((event) => event.event_id), ["a-0", "a-1"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restoring archived project history is idempotent and preserves its archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-history-restore-"));
  try {
    const eventsFile = join(root, "events.jsonl");
    const archiveFile = join(root, "archive.jsonl");
    await writeFile(eventsFile, `${JSON.stringify({ event_id: "new", project_name: "demo" })}\n`);
    await writeFile(archiveFile, `${JSON.stringify({ event_id: "old", project_name: "demo" })}\n${JSON.stringify({ event_id: "new", project_name: "demo" })}\n`);
    const first = await restoreProjectHistory({ project: "demo", eventsFile, archiveFile });
    const second = await restoreProjectHistory({ project: "demo", eventsFile, archiveFile });
    const restored = await readFile(eventsFile, "utf8");
    assert.equal(first.restored, 1);
    assert.equal(second.restored, 0);
    assert.equal(restored.split(/\r?\n/).filter(Boolean).length, 2);
    assert.equal((await readFile(archiveFile, "utf8")).includes('"old"'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
