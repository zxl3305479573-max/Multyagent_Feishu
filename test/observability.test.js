import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventLogger, projectTask } from "../src/observability.js";

test("event logger writes JSONL and task projection has table fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "multyagent-events-"));
  const file = join(dir, "events.jsonl");
  await createEventLogger(file)({ type: "task_started", task_id: "T-1" });
  const line = JSON.parse((await readFile(file, "utf8")).trim());
  assert.equal(line.type, "task_started");
  assert.equal(projectTask({ task_id: "T-1", status: "running", agent: "tester" }).owner_agent, "tester");
  await rm(dir, { recursive: true, force: true });
});
