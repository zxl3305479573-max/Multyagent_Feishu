import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TRACE_FIELD_SCHEMA, TRACE_KEY_FIELD, sanitizeTraceEvent, toTraceFields } from "./domain/trace.js";

const DEFAULT_MAPPING_FILE = "runtime/bitable-trace-records.json";
const DEFAULT_FLUSH_DELAY_MS = 500;
const DEFAULT_NETWORK_BACKOFF_MS = 30_000;
const NOT_FOUND = new Set([1254043, 1254003, 1254040]);

function isNetworkError(error) {
  const value = `${error?.code || ""} ${error?.message || error || ""}`;
  return /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/i.test(value);
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
  try { return normalize(await fn()); }
  catch (error) { return normalize(null, error); }
}

async function listFields(client, appToken, tableId) {
  const items = [];
  let pageToken;
  do {
    const response = await call(() => client.bitable.appTableField.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    }));
    if (!response.ok) throw new Error(`trace field list failed: code=${response.code} msg=${response.message}`);
    items.push(...(response.data?.items || []));
    pageToken = response.data?.has_more ? response.data?.page_token : null;
  } while (pageToken);
  return items;
}

export async function reconcileTraceFields(client, { appToken, tableId, autoInit = true, log = console } = {}) {
  const existing = new Set((await listFields(client, appToken, tableId)).map((field) => field.field_name));
  const missing = TRACE_FIELD_SCHEMA.filter((field) => !existing.has(field.name));
  if (!missing.length) return { created: [], failed: [] };
  if (!autoInit) return { created: [], failed: missing.map((field) => field.name) };
  const created = [];
  const failed = [];
  for (const field of missing) {
    const response = await call(() => client.bitable.appTableField.create({
      path: { app_token: appToken, table_id: tableId },
      data: {
        field_name: field.name,
        type: field.type,
        ui_type: field.ui_type,
        ...(field.property ? { property: field.property } : {}),
      },
    }));
    if (response.ok) created.push(field.name);
    else {
      failed.push(field.name);
      log.warn?.(`[bitable-trace] field create failed: ${field.name} code=${response.code} ${response.message}`);
    }
  }
  return { created, failed };
}

export function createBitableTraceSync({
  client,
  appToken,
  tableId,
  storageFile = process.env.FEISHU_BITABLE_TRACE_RECORDS_FILE || DEFAULT_MAPPING_FILE,
  historyFile = process.env.PI_EVENTS_FILE || "runtime/events.jsonl",
  log = console,
  flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
  maxAttempts = 3,
  networkBackoffMs = Number(process.env.FEISHU_BITABLE_NETWORK_BACKOFF_MS) || DEFAULT_NETWORK_BACKOFF_MS,
} = {}) {
  if (!client || !appToken || !tableId) throw new Error("createBitableTraceSync requires client, appToken and tableId");

  const events = new Map();
  const dirty = new Set();
  const attempts = new Map();
  const stats = { created: 0, updated: 0, failed: 0, skipped: 0, lastError: null };
  let mapping = null;
  let timer = null;
  let chain = Promise.resolve();
  let hydrated = false;
  let networkBackoffUntil = 0;
  let networkWarningActive = false;
  const queued = [];

  async function hydrate() {
    if (hydrated) return;
    hydrated = true;
    if (!historyFile) return;
    const records = await loadMapping();
    try {
      const lines = (await readFile(historyFile, "utf8")).split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = sanitizeTraceEvent(JSON.parse(line));
          if (event.event_id && event.task_id) {
            events.set(event.event_id, event);
            if (!records[event.event_id]?.record_id) dirty.add(event.event_id);
          }
        } catch {
        }
      }
    } catch {
    }
  }

  async function drain() {
    await hydrate();
    for (const event of queued.splice(0, queued.length)) events.set(event.event_id, event);
  }

  async function loadMapping() {
    if (mapping) return mapping;
    try {
      const value = JSON.parse(await readFile(storageFile, "utf8"));
      mapping = value && typeof value === "object" ? value : {};
    } catch {
      mapping = {};
    }
    return mapping;
  }

  async function saveMapping() {
    await mkdir(dirname(storageFile), { recursive: true });
    await writeFile(storageFile, JSON.stringify(mapping || {}, null, 2));
  }

  async function findRecordId(eventId) {
    const response = await call(() => client.bitable.appTableRecord.search({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 1 },
      data: { filter: { conjunction: "and", conditions: [{ field_name: TRACE_KEY_FIELD, operator: "is", value: [eventId] }] } },
    }));
    if (!response.ok) throw new Error(`trace search failed: code=${response.code} msg=${response.message}`);
    return response.data?.items?.[0]?.record_id || null;
  }

  async function writeEvent(eventId) {
    const event = events.get(eventId);
    if (!event) return;
    const fields = toTraceFields(event);
    const records = await loadMapping();
    let recordId = records[eventId]?.record_id || null;
    if (recordId) {
      const update = await call(() => client.bitable.appTableRecord.update({
        path: { app_token: appToken, table_id: tableId, record_id: recordId },
        data: { fields },
      }));
      if (update.ok) { stats.updated += 1; return; }
      if (!NOT_FOUND.has(update.code)) throw new Error(`trace update rejected: code=${update.code} msg=${update.message}`);
      delete records[eventId];
    }
    recordId = await findRecordId(eventId);
    if (recordId) {
      const update = await call(() => client.bitable.appTableRecord.update({
        path: { app_token: appToken, table_id: tableId, record_id: recordId },
        data: { fields },
      }));
      if (!update.ok) throw new Error(`trace update rejected: code=${update.code} msg=${update.message}`);
      records[eventId] = { record_id: recordId };
      await saveMapping();
      stats.updated += 1;
      return;
    }
    const create = await call(() => client.bitable.appTableRecord.create({
      path: { app_token: appToken, table_id: tableId },
      data: { fields },
    }));
    const createdId = create.data?.record?.record_id;
    if (!create.ok || !createdId) throw new Error(`trace create rejected: code=${create.code} msg=${create.message}`);
    records[eventId] = { record_id: createdId };
    await saveMapping();
    stats.created += 1;
  }

  async function flushEvents() {
    await drain();
    if (networkBackoffUntil > Date.now()) {
      schedule(networkBackoffUntil - Date.now());
      return;
    }
    const pending = [...dirty];
    dirty.clear();
    for (let index = 0; index < pending.length; index += 1) {
      const eventId = pending[index];
      try {
        await writeEvent(eventId);
        attempts.delete(eventId);
        networkBackoffUntil = 0;
        networkWarningActive = false;
      } catch (error) {
        stats.failed += 1;
        stats.lastError = error.message;
        if (isNetworkError(error)) {
          for (const remaining of pending.slice(index)) dirty.add(remaining);
          networkBackoffUntil = Date.now() + Math.max(0, Number(networkBackoffMs) || DEFAULT_NETWORK_BACKOFF_MS);
          if (!networkWarningActive) {
            networkWarningActive = true;
            log.warn?.(`[bitable-trace] Feishu 网络暂不可用，${Math.ceil(Math.max(0, Number(networkBackoffMs) || DEFAULT_NETWORK_BACKOFF_MS) / 1000)} 秒后重试：${error.message}`);
          }
          schedule(networkBackoffUntil - Date.now());
          break;
        }
        const count = (attempts.get(eventId) || 0) + 1;
        if (count < maxAttempts) { attempts.set(eventId, count); dirty.add(eventId); }
        else attempts.delete(eventId);
        log.warn?.(`[bitable-trace] event sync failed (${count}/${maxAttempts}): ${error.message}`);
      }
    }
    if (dirty.size && networkBackoffUntil <= Date.now()) schedule();
  }

  function runFlush() {
    chain = chain.then(flushEvents).catch((error) => {
      stats.failed += 1;
      stats.lastError = error.message;
      log.warn?.(`[bitable-trace] flush failed: ${error.message}`);
    });
    return chain;
  }

  function schedule(delayMs = flushDelayMs) {
    if (!(delayMs > 0) || timer) return;
    timer = setTimeout(() => { timer = null; void runFlush(); }, delayMs);
    timer.unref?.();
  }

  function handleEvent(input = {}) {
    const event = sanitizeTraceEvent(input);
    if (!event.event_id || !event.task_id) { stats.skipped += 1; return; }
    queued.push(event);
    dirty.add(event.event_id);
    schedule();
  }

  return { handleEvent, flush: runFlush, whenIdle: runFlush, stats };
}
