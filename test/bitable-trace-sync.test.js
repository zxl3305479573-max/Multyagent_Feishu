import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRACE_FIELD_SCHEMA } from "../src/domain/trace.js";
import { createBitableTraceSync, reconcileTraceFields } from "../src/bitable-trace-sync.js";

function makeClient(options = {}) {
  const calls = { fieldCreate: [], create: [], update: [], search: [] };
  const client = {
    bitable: {
      appTableField: {
        list: async () => ({ code: 0, data: { items: (options.fieldNames || []).map((field_name) => ({ field_name })) } }),
        create: async ({ data }) => { calls.fieldCreate.push(data); return { code: 0, data: {} }; },
      },
      appTableRecord: {
        create: async ({ data }) => {
          calls.create.push(data);
          return { code: 0, data: { record: { record_id: `rec-${calls.create.length}` } } };
        },
        update: async ({ path, data }) => { calls.update.push({ path, data }); return { code: 0, data: {} }; },
        search: async ({ data }) => {
          calls.search.push(data);
          return { code: 0, data: { items: options.searchItems || [] } };
        },
      },
    },
  };
  return { client, calls };
}

async function tempFile(t) {
  const dir = await mkdtemp(join(tmpdir(), "multyagent-trace-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "trace-records.json");
}

test("trace field reconciliation only creates missing fields and preserves select-free schema", async () => {
  const { client, calls } = makeClient({ fieldNames: ["事件编号", "时间"] });
  const result = await reconcileTraceFields(client, { appToken: "base", tableId: "trace" });
  assert.equal(result.failed.length, 0);
  assert.equal(calls.fieldCreate.length, TRACE_FIELD_SCHEMA.length - 2);
  assert.equal(calls.fieldCreate.some((field) => field.field_name === "事件编号"), false);
});

test("trace events are created once and repeated event IDs update the same row", async (t) => {
  const storageFile = await tempFile(t);
  const { client, calls } = makeClient();
  const sync = createBitableTraceSync({ client, appToken: "base", tableId: "trace", storageFile, historyFile: null, flushDelayMs: 0 });
  const event = { event_id: "evt-1", timestamp: "2026-09-23T01:00:00Z", type: "tool_call", task_id: "T:backend", agent: "backend_developer", command: "npm test" };
  sync.handleEvent(event);
  await sync.flush();
  sync.handleEvent({ ...event, timestamp: "2026-09-23T01:01:00Z", command: "npm test -- --runInBand" });
  await sync.flush();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].path.record_id, "rec-1");
  assert.equal(calls.update[0].data.fields["事件编号"], "evt-1");
  const mapping = JSON.parse(await readFile(storageFile, "utf8"));
  assert.equal(mapping["evt-1"].record_id, "rec-1");
});

test("trace failures stay local and remain available for a later retry", async (t) => {
  const storageFile = await tempFile(t);
  let fail = true;
  const { client, calls } = makeClient();
  client.bitable.appTableRecord.create = async ({ data }) => {
    calls.create.push(data);
    if (fail) return { code: 1254000, msg: "rejected" };
    return { code: 0, data: { record: { record_id: "rec-ok" } } };
  };
  const errors = [];
  const sync = createBitableTraceSync({
    client, appToken: "base", tableId: "trace", storageFile, historyFile: null, flushDelayMs: 0,
    log: { error: (message) => errors.push(message), warn: (message) => errors.push(message), info() {} },
  });
  assert.doesNotThrow(() => sync.handleEvent({ event_id: "evt-2", type: "task_started", task_id: "T-2" }));
  await sync.flush();
  assert.equal(errors.length, 1);
  fail = false;
  sync.handleEvent({ event_id: "evt-2", type: "task_started", task_id: "T-2" });
  await sync.flush();
  assert.equal(calls.create.length, 2);
  assert.equal(sync.stats.created, 1);
});

test("missing trace records are replayed from the local JSONL event log after restart", async (t) => {
  const storageFile = await tempFile(t);
  const historyFile = storageFile.replace("trace-records.json", "events.jsonl");
  await writeFile(historyFile, `${JSON.stringify({ event_id: "evt-replay", timestamp: "2026-09-23T01:00:00Z", type: "task_started", task_id: "T-replay", agent: "project_manager" })}\n`);
  const { client, calls } = makeClient();
  const sync = createBitableTraceSync({ client, appToken: "base", tableId: "trace", storageFile, historyFile, flushDelayMs: 0 });
  await sync.flush();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].fields["事件编号"], "evt-replay");
});
