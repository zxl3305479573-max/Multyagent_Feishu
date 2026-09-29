import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_FIELD_SCHEMA } from "../src/domain/bitable-board.js";
import { createBitableSync, createBoardEventSink, createCompactLogger, explainBitableError, reconcileFields, resolveBitableTarget } from "../src/bitable-sync.js";

const ALL_FIELDS = BOARD_FIELD_SCHEMA.map((field) => field.name);

function makeLog() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (message) => lines.info.push(String(message)),
    warn: (message) => lines.warn.push(String(message)),
    error: (message) => lines.error.push(String(message)),
  };
}

function makeClient(options = {}) {
  const calls = { getNode: [], fieldCreate: [], recordCreate: [], recordUpdate: [], recordSearch: [] };
  const fieldNames = options.fieldNames ?? ALL_FIELDS;
  return {
    calls,
    client: {
      wiki: {
        v2: {
          space: {
            getNode: async ({ params }) => {
              calls.getNode.push(params);
              if (options.getNodeFails) return { code: 1254005, msg: "node not found" };
              return { code: 0, data: { node: options.node ?? { obj_type: "bitable", obj_token: "bascnResolved" } } };
            },
          },
        },
      },
      bitable: {
        appTableField: {
          list: async () => ({
            code: 0,
            data: { items: fieldNames.map((name) => ({ field_name: name })) },
          }),
          create: async ({ data }) => {
            calls.fieldCreate.push(data);
            if (options.fieldCreateFails) return { code: 1254000, msg: "field rejected" };
            return { code: 0, data: { field: { field_id: `fld_${data.field_name}` } } };
          },
        },
        appTableRecord: {
          create: async ({ data }) => {
            calls.recordCreate.push(data);
            if (options.createFails) return { code: 1254000, msg: "create rejected" };
            return { code: 0, data: { record: { record_id: `rec_${calls.recordCreate.length}` } } };
          },
          update: async ({ path, data }) => {
            calls.recordUpdate.push({ path, data });
            if (options.staleRecordId && path.record_id === options.staleRecordId) {
              return { code: 1254043, msg: "RecordIdNotFound" };
            }
            return { code: 0, data: {} };
          },
          search: async ({ data }) => {
            calls.recordSearch.push(data);
            // The first lookup runs before the initial create, so fixtures can
            // hold the hit back until the recovery lookup.
            const items = calls.recordSearch.length >= (options.searchItemsFromCall ?? 1) ? options.searchItems ?? [] : [];
            return { code: 0, data: { items } };
          },
        },
      },
    },
  };
}

async function makeStorage(t) {
  const dir = await mkdtemp(join(tmpdir(), "multyagent-bitable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "records.json");
}

test("resolveBitableTarget prefers a direct app token", async () => {
  const { client, calls } = makeClient();
  const token = await resolveBitableTarget({ client, wikiToken: "wikcn_ignored", appToken: "bascnDirect" });
  assert.equal(token, "bascnDirect");
  assert.equal(calls.getNode.length, 0);
});

test("resolveBitableTarget resolves a wiki node to its bitable object token", async () => {
  const { client, calls } = makeClient();
  const token = await resolveBitableTarget({ client, wikiToken: "wikcn_1" });
  assert.equal(token, "bascnResolved");
  assert.deepEqual(calls.getNode, [{ token: "wikcn_1" }]);
});

test("resolveBitableTarget rejects a wiki node that is not a bitable", async () => {
  const { client } = makeClient({ node: { obj_type: "docx", obj_token: "doxcn_1" } });
  await assert.rejects(() => resolveBitableTarget({ client, wikiToken: "wikcn_1" }), /not a bitable/);
});

test("resolveBitableTarget requires some token", async () => {
  const { client } = makeClient();
  await assert.rejects(() => resolveBitableTarget({ client }), /FEISHU_BITABLE/);
});

test("reconcileFields creates only the missing fields", async () => {
  const { client, calls } = makeClient({ fieldNames: ["任务编号", "任务"] });
  const log = makeLog();
  const result = await reconcileFields(client, { appToken: "bascn", tableId: "tbl", log });

  const created = calls.fieldCreate.map((item) => item.field_name);
  assert.equal(created.includes("任务编号"), false, "existing fields must not be recreated");
  assert.equal(created.includes("状态"), true);
  assert.equal(result.failed.length, 0);
  assert.equal(created.length, ALL_FIELDS.length - 2);
});

test("reconcileFields is a no-op when the schema is complete", async () => {
  const { client, calls } = makeClient();
  const result = await reconcileFields(client, { appToken: "bascn", tableId: "tbl", log: makeLog() });
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.failed, []);
  assert.equal(calls.fieldCreate.length, 0);
});

test("reconcileFields reports missing fields when auto init is disabled", async () => {
  const { client, calls } = makeClient({ fieldNames: ["文本"] });
  const log = makeLog();
  const result = await reconcileFields(client, { appToken: "bascn", tableId: "tbl", autoInit: false, log });
  assert.equal(calls.fieldCreate.length, 0);
  assert.equal(result.failed.length, ALL_FIELDS.length);
  assert.ok(log.lines.warn.some((line) => line.includes("disabled")));
});

test("reconcileFields returns available fields when a missing field cannot be created", async () => {
  const keyField = BOARD_FIELD_SCHEMA[1].name;
  const statusField = BOARD_FIELD_SCHEMA[4].name;
  const progressField = BOARD_FIELD_SCHEMA[5].name;
  const { client } = makeClient({ fieldNames: [keyField, statusField], fieldCreateFails: true });
  const result = await reconcileFields(client, { appToken: "bascn", tableId: "tbl", log: makeLog() });
  assert.ok(result.failed.includes(progressField));
  assert.ok(result.available.includes(statusField));
  assert.equal(result.available.includes(progressField), false);
});

test("the projector creates one record and then updates it in place", async (t) => {
  const storageFile = await makeStorage(t);
  const { client, calls } = makeClient();
  const sync = createBitableSync({ client, appToken: "bascn", tableId: "tbl", storageFile, flushDelayMs: 0, log: makeLog() });

  sync.handleEvent({ type: "task_created", task_id: "T-1", agent: "project_manager", chat_id: "c1", text: "学生管理系统", timestamp: "2026-09-22T01:00:00.000Z" });
  sync.handleEvent({ type: "task_started", task_id: "T-1", agent: "project_manager", timestamp: "2026-09-22T01:00:01.000Z" });
  await sync.whenIdle();

  assert.equal(calls.recordCreate.length, 1);
  assert.equal(calls.recordCreate[0].fields["任务编号"], "T-1");
  assert.equal(calls.recordCreate[0].fields["任务"], "学生管理系统");
  assert.equal(calls.recordCreate[0].fields["状态"], "执行中");

  sync.handleEvent({ type: "approval_required", task_id: "T-1", agent: "project_manager", chat_id: "c1", timestamp: "2026-09-22T01:00:02.000Z" });
  await sync.whenIdle();

  assert.equal(calls.recordCreate.length, 1, "later events must not create a second row");
  assert.equal(calls.recordUpdate.length, 1);
  assert.equal(calls.recordUpdate[0].path.record_id, "rec_1");
  assert.equal(calls.recordUpdate[0].data.fields["状态"], "待确认");

  const persisted = JSON.parse(await readFile(storageFile, "utf8"));
  assert.equal(persisted["T-1"].record_id, "rec_1");
});

test("the projector omits unavailable fields instead of dropping the task update", async (t) => {
  const storageFile = await makeStorage(t);
  const { client, calls } = makeClient();
  const keyField = BOARD_FIELD_SCHEMA[1].name;
  const statusField = BOARD_FIELD_SCHEMA[4].name;
  const sync = createBitableSync({ client, appToken: "bascn", tableId: "tbl", storageFile, availableFields: [keyField, statusField], flushDelayMs: 0, log: makeLog() });
  sync.handleEvent({ type: "task_started", task_id: "T-partial", agent: "project_manager" });
  await sync.whenIdle();
  assert.equal(calls.recordCreate.length, 1);
  assert.deepEqual(Object.keys(calls.recordCreate[0].fields).sort(), [keyField, statusField].sort());
});

test("the projector ignores events without a task id", async (t) => {
  const storageFile = await makeStorage(t);
  const { client, calls } = makeClient();
  const sync = createBitableSync({ client, appToken: "bascn", tableId: "tbl", storageFile, flushDelayMs: 0, log: makeLog() });

  sync.handleEvent({ type: "message_received", chat_id: "c1", agent: "architect" });
  sync.handleEvent({ type: "message_ignored", chat_id: "c1", reason: "routing" });
  await sync.whenIdle();

  assert.equal(calls.recordCreate.length, 0);
  assert.equal(calls.recordUpdate.length, 0);
});

test("a stale record id falls back to a search by task id", async (t) => {
  const storageFile = await makeStorage(t);
  const { client, calls } = makeClient({
    staleRecordId: "rec_1",
    searchItems: [{ record_id: "rec_found" }],
    searchItemsFromCall: 2,
  });
  const log = makeLog();
  const sync = createBitableSync({ client, appToken: "bascn", tableId: "tbl", storageFile, flushDelayMs: 0, log });

  sync.handleEvent({ type: "task_started", task_id: "T-2", agent: "tester", timestamp: "2026-09-22T02:00:00.000Z" });
  await sync.whenIdle();
  assert.equal(calls.recordCreate.length, 1, "the first write creates the row");

  sync.handleEvent({ type: "task_settle", task_id: "T-2", reason: "final", timestamp: "2026-09-22T02:05:00.000Z" });
  await sync.whenIdle();

  assert.equal(calls.recordSearch.length, 2);
  assert.equal(calls.recordSearch[0].filter.conditions[0].field_name, "任务编号");
  assert.deepEqual(calls.recordSearch[0].filter.conditions[0].value, ["T-2"]);
  assert.equal(calls.recordUpdate.length, 2, "the stale update plus the retry against the found record");
  assert.equal(calls.recordUpdate[1].path.record_id, "rec_found");
  assert.equal(calls.recordCreate.length, 1, "a found row must be updated, not duplicated");

  const persisted = JSON.parse(await readFile(storageFile, "utf8"));
  assert.equal(persisted["T-2"].record_id, "rec_found");
});

test("a failing write is logged and never rejects the caller", async (t) => {
  const storageFile = await makeStorage(t);
  const { client } = makeClient({ createFails: true });
  const log = makeLog();
  const sync = createBitableSync({ client, appToken: "bascn", tableId: "tbl", storageFile, flushDelayMs: 0, log });

  sync.handleEvent({ type: "task_started", task_id: "T-3", agent: "tester", timestamp: "2026-09-22T03:00:00.000Z" });
  await sync.whenIdle();

  assert.equal(sync.stats.failed, 1);
  assert.match(sync.stats.lastError, /create rejected/);
  assert.ok(
    log.lines.warn.length + log.lines.error.length >= 1,
    "a failed write must leave a trace in the gateway log",
  );
});

test("the board sink forwards logged events to the projector", async () => {
  const seen = [];
  const sink = createBoardEventSink({
    logger: async (event) => ({ ...event, logged: true }),
    sync: { handleEvent: (event) => seen.push(event) },
  });

  const entry = await sink({ type: "task_started", task_id: "T-9" });

  assert.equal(entry.logged, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].task_id, "T-9");
});

test("the trace sink works without a board projector", async () => {
  const seen = [];
  const sink = createBoardEventSink({ logger: async (event) => event, trace: { handleEvent: (event) => seen.push(event) } });
  await sink({ type: "dispatch_started", task_id: "T-1:backend" });
  assert.equal(seen.length, 1);
});

test("a projector failure never breaks the log sink", async () => {
  const log = makeLog();
  const sink = createBoardEventSink({
    logger: async (event) => event,
    sync: { handleEvent: () => { throw new Error("board offline"); } },
    log,
  });

  const entry = await sink({ type: "task_started", task_id: "T-10" });

  assert.equal(entry.task_id, "T-10");
  assert.ok(log.lines.warn.some((line) => line.includes("board offline")));
});

test("the board sink works without a projector", async () => {
  const sink = createBoardEventSink({ logger: async (event) => event });
  const entry = await sink({ type: "task_started", task_id: "T-11" });
  assert.equal(entry.task_id, "T-11");
});

test("explainBitableError turns a forbidden response into an actionable hint", () => {
  const hint = explainBitableError(91403, "Forbidden");
  assert.match(hint, /91403/);
  assert.match(hint, /collaborator/i);
});

test("explainBitableError falls back to the raw code and message", () => {
  assert.equal(explainBitableError(1254000, "bad request"), "code=1254000 bad request");
  assert.equal(explainBitableError(null, "socket hang up"), "code=unknown socket hang up");
});

test("the projector retries a failed write on the next flush", async (t) => {
  const storageFile = await makeStorage(t);
  const { client, calls } = makeClient({ createFails: true });
  const log = makeLog();
  const sync = createBitableSync({ client, appToken: "bascn", tableId: "tbl", storageFile, flushDelayMs: 0, log, maxAttempts: 3 });

  sync.handleEvent({ type: "task_started", task_id: "T-12", agent: "tester", timestamp: "2026-09-22T04:00:00.000Z" });
  await sync.whenIdle();
  assert.equal(sync.stats.failed, 1);
  assert.equal(calls.recordCreate.length, 1);

  // The table recovers before the attempted retry.
  client.bitable.appTableRecord.create = async ({ data }) => {
    calls.recordCreate.push(data);
    return { code: 0, data: { record: { record_id: "rec_recovered" } } };
  };
  await sync.whenIdle();
  assert.equal(sync.stats.created, 1);
  assert.equal(calls.recordCreate.length, 2);
});

test("the projector gives up after maxAttempts", async (t) => {
  const storageFile = await makeStorage(t);
  const { client, calls } = makeClient({ createFails: true });
  const sync = createBitableSync({ client, appToken: "bascn", tableId: "tbl", storageFile, flushDelayMs: 0, log: makeLog(), maxAttempts: 2 });

  sync.handleEvent({ type: "task_started", task_id: "T-13", agent: "tester", timestamp: "2026-09-22T05:00:00.000Z" });
  await sync.whenIdle();
  await sync.whenIdle();
  await sync.whenIdle();

  assert.equal(calls.recordCreate.length, 2, "attempts must stay capped");
});

test("the compact logger collapses SDK error dumps into one line", () => {
  const lines = [];
  const sink = { error: (line) => lines.push(line), warn: (line) => lines.push(line) };
  const logger = createCompactLogger(sink);

  logger.error([{ message: "Request failed with status code 403" }, { code: 91403, msg: "Forbidden", data: {} }]);
  logger.warn("plain message");

  assert.equal(lines.length, 2);
  assert.equal(lines[0].includes("\n"), false);
  assert.match(lines[0], /403/);
  assert.equal(lines[1], "[feishu] plain message");
});

test("the compact logger survives a circular payload", () => {
  const lines = [];
  const logger = createCompactLogger({ error: (line) => lines.push(line) });
  const circular = { name: "boom" };
  circular.self = circular;

  logger.error(circular);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /boom/);
});

test("the compact logger suppresses duplicate Feishu DNS errors briefly", () => {
  const lines = [];
  const logger = createCompactLogger({ error: (line) => lines.push(line) }, { networkErrorWindowMs: 1_000 });

  logger.error("getaddrinfo ENOTFOUND open.feishu.cn");
  logger.error("getaddrinfo ENOTFOUND open.feishu.cn");
  logger.error("getaddrinfo ENOTFOUND another.feishu.cn");

  assert.equal(lines.length, 2);
  assert.match(lines[0], /open\.feishu\.cn/);
  assert.match(lines[1], /another\.feishu\.cn/);
});

test("a restart rebuilds prior state so an old row keeps its fields", async (t) => {
  const storageFile = await makeStorage(t);
  const historyFile = join(storageFile, "..", "events.jsonl");
  await writeFile(historyFile, [
    JSON.stringify({ type: "task_created", task_id: "T-20", agent: "project_manager", chat_id: "c1", text: "做一个学生管理系统", timestamp: "2026-09-22T01:00:00.000Z" }),
    JSON.stringify({ type: "task_started", task_id: "T-20", agent: "project_manager", project_name: "student", timestamp: "2026-09-22T01:00:01.000Z" }),
    "",
  ].join("\n"));

  const { client, calls } = makeClient();
  const sync = createBitableSync({ client, appToken: "bascn", tableId: "tbl", storageFile, historyFile, flushDelayMs: 0, log: makeLog() });

  // Only a later event arrives after the restart.
  sync.handleEvent({ type: "dispatch_started", task_id: "T-20:architect", parent_task_id: "T-20", target: "architect", timestamp: "2026-09-22T01:00:02.000Z" });
  await sync.whenIdle();

  assert.equal(calls.recordCreate.length, 1);
  assert.equal(calls.recordCreate[0].fields["任务"], "做一个学生管理系统");
  assert.equal(calls.recordCreate[0].fields["项目"], "student");
  assert.equal(calls.recordCreate[0].fields["负责人"], "架构设计师");
});

test("a malformed history line is skipped instead of breaking the board", async (t) => {
  const storageFile = await makeStorage(t);
  const historyFile = join(storageFile, "..", "events.jsonl");
  await writeFile(historyFile, [
    "{ this is not json",
    JSON.stringify({ type: "task_started", task_id: "T-21", agent: "tester", timestamp: "2026-09-22T02:00:00.000Z" }),
  ].join("\n"));

  const { client, calls } = makeClient();
  const sync = createBitableSync({ client, appToken: "bascn", tableId: "tbl", storageFile, historyFile, flushDelayMs: 0, log: makeLog() });
  sync.handleEvent({ type: "task_settle", task_id: "T-21", reason: "final", timestamp: "2026-09-22T02:05:00.000Z" });
  await sync.whenIdle();

  assert.equal(calls.recordCreate.length, 1);
  assert.equal(calls.recordCreate[0].fields["负责人"], "测试");
});

test("redo rewrites a task row from the restored state", async (t) => {
  const storageFile = await makeStorage(t);
  const historyFile = join(storageFile, "..", "events.jsonl");
  await writeFile(historyFile, [
    JSON.stringify({ type: "task_created", task_id: "T-30", agent: "project_manager", chat_id: "c1", text: "修复这条记录", timestamp: "2026-09-22T06:00:00.000Z" }),
    JSON.stringify({ type: "task_settle", task_id: "T-30", reason: "final", timestamp: "2026-09-22T06:10:00.000Z" }),
  ].join("\n"));

  const { client, calls } = makeClient();
  const sync = createBitableSync({ client, appToken: "bascn", tableId: "tbl", storageFile, historyFile, flushDelayMs: 0, log: makeLog() });

  assert.equal(await sync.redo("T-30"), true);
  assert.equal(calls.recordCreate.length, 1);
  assert.equal(calls.recordCreate[0].fields["任务"], "修复这条记录");
  assert.equal(calls.recordCreate[0].fields["状态"], "已完成");

  assert.equal(await sync.redo("missing-task"), false);
});
