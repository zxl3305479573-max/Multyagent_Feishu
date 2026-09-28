// One-way projection of gateway task state into a Feishu Bitable task board.
//
// The gateway owns task state; the table is a read-only dashboard for humans.
// Every failure here is logged and swallowed so a Bitable outage can never
// block an agent run, an approval card, or a downstream dispatch.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BOARD_FIELD_SCHEMA,
  KEY_FIELD,
  initialBoardState,
  reduceEvent,
  rootTaskIdFor,
  toBitableFields,
} from "./domain/bitable-board.js";

const DEFAULT_FIELDS_FILE = "runtime/bitable-records.json";
const DEFAULT_FLUSH_DELAY_MS = 400;
// Feishu reports a missing record id as a business error rather than a 404.
const RECORD_NOT_FOUND_CODES = new Set([1254043, 1254003, 1254040]);
const FORBIDDEN_CODES = new Set([91403, 99991672, 99991663]);

// Feishu reports permission problems as a bare "Forbidden"; turn that into
// something a human can act on without reading the API docs.
export function explainBitableError(code, message = "") {
  const detail = `code=${code ?? "unknown"} ${message || ""}`.trim();
  if (FORBIDDEN_CODES.has(code)) {
    return `${detail} — the app can read but not write this table. Add the project-manager app as an editable collaborator of the Bitable (for a Wiki-hosted table, add it to the wiki space with edit rights) and make sure the bitable:app scope has been published in a released app version.`;
  }
  return detail;
}

function parseErrorCode(message = "") {
  const match = /code=(\d+)/.exec(String(message));
  return match ? Number(match[1]) : null;
}

function describeArg(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.message;
  if (Array.isArray(arg)) return arg.map(describeArg).join(" ");
  if (arg && typeof arg === "object") {
    const summary = arg.msg || arg.message || arg.name;
    if (summary) return `${arg.code ? `code=${arg.code} ` : ""}${summary}`;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

// The SDK logs whole axios payloads on failure, which buries the actionable
// line. Keep one compact line per event and let our own messages carry detail.
export function createCompactLogger(sink = console) {
  const format = (args) => args
    .map(describeArg)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return {
    error: (...args) => sink.error?.(`[feishu] ${format(args)}`),
    warn: (...args) => sink.warn?.(`[feishu] ${format(args)}`),
    info: () => {},
    debug: () => {},
  };
}

// Wraps the JSONL event logger so the same event that lands in
// runtime/events.jsonl also feeds the board projector.
export function createBoardEventSink({ logger, sync, trace, log = console } = {}) {
  return async function recordEvent(event = {}) {
    const entry = logger ? await logger(event) : { ...event };
    if (sync) {
      try {
        sync.handleEvent(entry);
      } catch (error) {
        log.warn?.(`[bitable] projection skipped: ${error.message}`);
      }
    }
    if (trace) {
      try {
        trace.handleEvent(entry);
      } catch (error) {
        log.warn?.(`[bitable-trace] projection skipped: ${error.message}`);
      }
    }
    return entry;
  };
}

function normalize(response, error) {
  if (error) {
    const body = error.response?.data;
    return { ok: false, code: body?.code ?? null, message: body?.msg || error.message || String(error) };
  }
  const code = response?.code ?? 0;
  return { ok: code === 0, code, message: response?.msg || "", data: response?.data };
}

async function call(fn) {
  try {
    return normalize(await fn());
  } catch (error) {
    return normalize(null, error);
  }
}

export async function resolveBitableTarget({ client, wikiToken, appToken } = {}) {
  if (appToken) return appToken;
  if (!wikiToken) {
    throw new Error("missing FEISHU_BITABLE_APP_TOKEN or FEISHU_BITABLE_WIKI_TOKEN");
  }
  const result = await call(() => client.wiki.v2.space.getNode({ params: { token: wikiToken } }));
  if (!result.ok) {
    throw new Error(`wiki node resolve failed: code=${result.code} msg=${result.message}`);
  }
  const node = result.data?.node;
  if (node?.obj_type !== "bitable" || !node?.obj_token) {
    throw new Error(`wiki node is not a bitable: obj_type=${node?.obj_type ?? "unknown"}`);
  }
  return node.obj_token;
}

export async function listFieldNames(client, { appToken, tableId } = {}) {
  const result = await call(() => client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  }));
  if (!result.ok) {
    throw new Error(`bitable field list failed: code=${result.code} msg=${result.message}`);
  }
  return (result.data?.items || []).map((item) => item.field_name).filter(Boolean);
}

// Additive only: existing fields are never renamed, retyped, or removed.
export async function reconcileFields(client, {
  appToken,
  tableId,
  schema = BOARD_FIELD_SCHEMA,
  autoInit = true,
  log = console,
} = {}) {
  const existing = new Set(await listFieldNames(client, { appToken, tableId }));
  const missing = schema.filter((field) => !existing.has(field.name));
  if (!missing.length) return { created: [], failed: [], available: [...existing] };

  if (!autoInit) {
    log.warn?.(`[bitable] field auto init disabled; missing fields: ${missing.map((field) => field.name).join(", ")}`);
    return { created: [], failed: missing.map((field) => field.name), available: [...existing] };
  }

  const created = [];
  const failed = [];
  for (const field of missing) {
    const result = await call(() => client.bitable.appTableField.create({
      path: { app_token: appToken, table_id: tableId },
      data: {
        field_name: field.name,
        type: field.type,
        ui_type: field.ui_type,
        ...(field.property ? { property: field.property } : {}),
      },
    }));
    if (result.ok) created.push(field.name);
    else {
      failed.push(field.name);
      log.error?.(`[bitable] field create failed: ${field.name} ${explainBitableError(result.code, result.message)}`);
    }
  }
  if (created.length) log.info?.(`[bitable] created ${created.length} board field(s): ${created.join(", ")}`);
  return { created, failed, available: [...existing, ...created] };
}

export function createBitableSync({
  client,
  appToken,
  tableId,
  storageFile = process.env.FEISHU_BITABLE_RECORDS_FILE || DEFAULT_FIELDS_FILE,
  historyFile = process.env.PI_EVENTS_FILE || "runtime/events.jsonl",
  log = console,
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  maxAttempts = 3,
  now = () => new Date().toISOString(),
  availableFields = null,
} = {}) {
  if (!client || !appToken || !tableId) {
    throw new Error("createBitableSync requires client, appToken and tableId");
  }

  const states = new Map();
  const dirty = new Set();
  const attempts = new Map();
  const stats = { created: 0, updated: 0, failed: 0, skipped: 0, lastError: null };
  let records = null;
  let timer = null;
  let chain = Promise.resolve();
  let hydrated = false;
  const queue = [];

  // After a restart the in-memory state is empty, and the next event for an
  // old task would overwrite its row with a partial picture (an empty title,
  // for example). Replaying the event log rebuilds the state first.
  async function hydrate() {
    if (hydrated) return;
    hydrated = true;
    if (!historyFile) return;
    let lines;
    try {
      lines = (await readFile(historyFile, "utf8")).split(/\r?\n/);
    } catch {
      return;
    }
    let replayed = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const taskId = rootTaskIdFor(event);
      if (!taskId) continue;
      states.set(taskId, reduceEvent(states.get(taskId) || initialBoardState(taskId), event));
      replayed += 1;
    }
    if (replayed) log.info?.(`[bitable] restored ${states.size} task state(s) from ${historyFile}`);
  }

  // Events arrive synchronously while the log replay is asynchronous, so they
  // wait in a queue and are applied on top of the restored state.
  async function drainQueue() {
    await hydrate();
    const batch = queue.splice(0, queue.length);
    for (const { taskId, event } of batch) {
      states.set(taskId, reduceEvent(states.get(taskId) || initialBoardState(taskId), event));
    }
  }

  async function loadRecords() {
    if (records) return records;
    try {
      const parsed = JSON.parse(await readFile(storageFile, "utf8"));
      records = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      records = {};
    }
    return records;
  }

  async function saveRecords() {
    try {
      await mkdir(dirname(storageFile), { recursive: true });
      await writeFile(storageFile, JSON.stringify(records ?? {}, null, 2));
    } catch (error) {
      log.error?.(`[bitable] record map persist failed: ${error.message}`);
    }
  }

  async function findRecordId(taskId) {
    const result = await call(() => client.bitable.appTableRecord.search({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 1 },
      data: {
        filter: {
          conjunction: "and",
          conditions: [{ field_name: KEY_FIELD, operator: "is", value: [taskId] }],
        },
      },
    }));
    if (!result.ok) {
      log.warn?.(`[bitable] record search failed: task=${taskId} code=${result.code} msg=${result.message}`);
      return null;
    }
    return result.data?.items?.[0]?.record_id ?? null;
  }

  async function updateRecord(recordId, fields) {
    const result = await call(() => client.bitable.appTableRecord.update({
      path: { app_token: appToken, table_id: tableId, record_id: recordId },
      data: { fields },
    }));
    return { ...result, notFound: !result.ok && RECORD_NOT_FOUND_CODES.has(result.code) };
  }

  async function createRecord(fields) {
    const result = await call(() => client.bitable.appTableRecord.create({
      path: { app_token: appToken, table_id: tableId },
      data: { fields },
    }));
    return { ...result, recordId: result.data?.record?.record_id ?? null };
  }

  async function remember(taskId, recordId) {
    const map = await loadRecords();
    map[taskId] = { record_id: recordId, updated_at: now() };
    await saveRecords();
  }

  async function forget(taskId) {
    const map = await loadRecords();
    if (map[taskId]) {
      delete map[taskId];
      await saveRecords();
    }
  }

  async function writeRecord(taskId) {
    const state = states.get(taskId);
    if (!state) return;
    const allFields = toBitableFields(state);
    const fields = availableFields?.length
      ? Object.fromEntries(Object.entries(allFields).filter(([name]) => availableFields.includes(name)))
      : allFields;
    const map = await loadRecords();
    const mapped = map[taskId]?.record_id ?? null;

    if (mapped) {
      const updated = await updateRecord(mapped, fields);
      if (updated.ok) {
        stats.updated += 1;
        return;
      }
      if (!updated.notFound) throw new Error(`update rejected code=${updated.code} msg=${updated.message}`);
      log.warn?.(`[bitable] stale record id for ${taskId}; falling back to search`);
      await forget(taskId);
    }

    const existing = await findRecordId(taskId);
    if (existing) {
      await remember(taskId, existing);
      const updated = await updateRecord(existing, fields);
      if (!updated.ok) throw new Error(`update rejected code=${updated.code} msg=${updated.message}`);
      stats.updated += 1;
      return;
    }

    const created = await createRecord(fields);
    if (!created.ok || !created.recordId) {
      throw new Error(`create rejected code=${created.code} msg=${created.message}`);
    }
    await remember(taskId, created.recordId);
    stats.created += 1;
  }

  async function flush() {
    await drainQueue();
    const pending = [...dirty].filter((taskId) => states.has(taskId));
    dirty.clear();
    for (const taskId of pending) {
      try {
        await writeRecord(taskId);
        attempts.delete(taskId);
      } catch (error) {
        stats.failed += 1;
        stats.lastError = error.message;
        const used = (attempts.get(taskId) || 0) + 1;
        if (used < maxAttempts) {
          attempts.set(taskId, used);
          dirty.add(taskId);
          log.warn?.(`[bitable] sync retry ${used}/${maxAttempts} for task=${taskId}: ${explainBitableError(parseErrorCode(error.message), error.message)}`);
        } else {
          attempts.delete(taskId);
          log.error?.(`[bitable] sync failed after ${used} attempt(s): task=${taskId} ${explainBitableError(parseErrorCode(error.message), error.message)}`);
        }
      }
    }
    // Anything still pending gets another pass on the retry timer.
    if (dirty.size) schedule();
  }

  function runFlush() {
    chain = chain.then(() => flush()).catch((error) => {
      stats.failed += 1;
      stats.lastError = error.message;
      log.error?.(`[bitable] flush failed: ${error.message}`);
    });
    return chain;
  }

  function schedule() {
    if (!(flushDelayMs > 0) || timer) return;
    timer = setTimeout(() => {
      timer = null;
      runFlush();
    }, flushDelayMs);
    timer.unref?.();
  }

  // Events without a task id (raw group messages, routing decisions) are not
  // board rows; only workflow events are projected.
  function handleEvent(event = {}) {
    const taskId = rootTaskIdFor(event);
    if (!taskId) {
      stats.skipped += 1;
      return;
    }
    queue.push({ taskId, event });
    dirty.add(taskId);
    schedule();
  }

  return {
    handleEvent,
    flush: runFlush,
    whenIdle: () => runFlush(),
    // Force a rewrite of one task from the restored event history. Used to
    // repair rows after a board schema change.
    redo: async (taskId) => {
      await drainQueue();
      if (!states.has(taskId)) return false;
      dirty.add(taskId);
      await runFlush();
      return true;
    },
    stateFor: (taskId) => states.get(taskId) ?? null,
    stats,
  };
}
