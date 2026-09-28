// Idempotent setup and migration for the Bitable task board.
//
// Makes the board human-readable: Chinese column names, Chinese status and
// owner values, typed columns, and one unfiltered overview view. Re-running is
// safe because every step checks the current table first. Use --dry-run to see
// the plan without touching the table.
import "dotenv/config";
import { Client } from "@larksuiteoapi/node-sdk";
import { createCompactLogger, explainBitableError, resolveBitableTarget } from "../src/bitable-sync.js";
import { BOARD_FIELD_SCHEMA, OWNER_LABELS, STAGE_LABELS, STATUS_LABELS } from "../src/domain/bitable-board.js";

const dryRun = process.argv.includes("--dry-run");
const appId = process.env.FEISHU_PROJECT_MANAGER_APP_ID;
const appSecret = process.env.FEISHU_PROJECT_MANAGER_APP_SECRET;
const wikiToken = process.env.FEISHU_BITABLE_WIKI_TOKEN;
const explicitAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
const tableId = process.env.FEISHU_BITABLE_TABLE_ID;

if (!appId || !appSecret || !tableId || (!wikiToken && !explicitAppToken)) {
  console.error("missing FEISHU_PROJECT_MANAGER_APP_ID/SECRET or FEISHU_BITABLE_* configuration");
  process.exit(1);
}

// English names from the first version of the board, mapped to their Chinese
// replacements. `title` is the primary column, so it is renamed in place.
const RENAMES = {
  title: "任务",
  task_id: "任务编号",
  project_id: "项目",
  owner_agent: "负责人",
  status: "状态",
  stage: "阶段",
  current_action: "当前动作",
  blocker: "阻塞",
  risk: "风险",
  output_artifacts: "交付物",
  started_at: "开始时间",
  updated_at: "更新时间",
  completed_at: "完成时间",
};

// Columns the board does not use: their data sources were never wired, so they
// only added empty lines to every card.
const DROP_COLUMNS = ["priority", "progress", "depends_on", "input_artifacts", "attempt"];

const STATUS_OPTIONS = Object.values(STATUS_LABELS);
const OWNER_OPTIONS = Object.values(OWNER_LABELS);

const client = new Client({ appId, appSecret, logger: createCompactLogger() });
const appToken = await resolveBitableTarget({ client, wikiToken, appToken: explicitAppToken });
const path = { app_token: appToken, table_id: tableId };

function report(label, result) {
  if (result.ok) {
    console.log(`  ok    ${label}`);
    return true;
  }
  console.error(`  FAIL  ${label}: ${explainBitableError(result.code, result.message)}`);
  return false;
}

async function call(fn) {
  try {
    const response = await fn();
    const code = response?.code ?? 0;
    return { ok: code === 0, code, message: response?.msg || "", data: response?.data };
  } catch (error) {
    const body = error.response?.data;
    return { ok: false, code: body?.code ?? null, message: body?.msg || error.message, data: null };
  }
}

function plainText(value) {
  if (Array.isArray(value)) return value.map((item) => item?.text ?? "").join("");
  return String(value ?? "");
}

async function listFields() {
  const result = await call(() => client.bitable.appTableField.list({ path, params: { page_size: 100 } }));
  if (!result.ok) throw new Error(`field list failed: ${explainBitableError(result.code, result.message)}`);
  return result.data?.items ?? [];
}

async function listRecords() {
  const result = await call(() => client.bitable.appTableRecord.search({ path, params: { page_size: 500 }, data: {} }));
  if (!result.ok) throw new Error(`record list failed: ${explainBitableError(result.code, result.message)}`);
  return result.data?.items ?? [];
}

async function renameColumns(fields) {
  const names = new Set(fields.map((field) => field.field_name));
  for (const [from, to] of Object.entries(RENAMES)) {
    if (!names.has(from) || names.has(to)) continue;
    if (dryRun) {
      console.log(`  plan  rename column ${from} -> ${to}`);
      continue;
    }
    const field = fields.find((item) => item.field_name === from);
    const renamed = await call(() => client.bitable.appTableField.update({
      path: { ...path, field_id: field.field_id },
      data: { field_name: to, type: field.type },
    }));
    await report(`rename column ${from} -> ${to}`, renamed);
  }
}

const LABEL_COLUMNS = [
  ["状态", STATUS_LABELS],
  ["负责人", OWNER_LABELS],
  ["阶段", STAGE_LABELS],
];

// The first board version wrote English keys. Capture them before the type
// conversion, because turning a text column into a single select drops values
// that are not yet valid options.
async function captureLegacyValues() {
  const captured = new Map();
  for (const record of await listRecords()) {
    const patch = {};
    for (const [column, labels] of LABEL_COLUMNS) {
      const current = plainText(record.fields?.[column]).trim();
      if (current && labels[current]) patch[column] = labels[current];
    }
    if (Object.keys(patch).length) captured.set(record.record_id, patch);
  }
  if (captured.size) console.log(`  ok    captured ${captured.size} legacy row(s) for translation`);
  else console.log("  skip  no legacy values to translate");
  return captured;
}

async function applyTranslatedValues(captured) {
  for (const [recordId, patch] of captured) {
    if (dryRun) {
      console.log(`  plan  translate values in ${recordId}: ${JSON.stringify(patch)}`);
      continue;
    }
    const updated = await call(() => client.bitable.appTableRecord.update({
      path: { ...path, record_id: recordId },
      data: { fields: patch },
    }));
    await report(`translate values in ${recordId}`, updated);
  }
}

async function ensureSingleSelect(field, options) {
  if (!field) {
    console.log(`  skip  no column needs converting to single select`);
    return true;
  }
  if (field.type === 3) {
    const existing = new Set((field.property?.options ?? []).map((option) => option.name));
    const missing = options.filter((option) => !existing.has(option));
    if (!missing.length) {
      console.log(`  skip  ${field.field_name} is already a single select`);
      return true;
    }
  }
  if (dryRun) {
    console.log(`  plan  convert ${field.field_name} to single select with ${options.length} Chinese option(s)`);
    return true;
  }
  const result = await call(() => client.bitable.appTableField.update({
    path: { ...path, field_id: field.field_id },
    data: {
      field_name: field.field_name,
      type: 3,
      property: { options: options.map((name, index) => ({ name, color: index })) },
    },
  }));
  return report(`convert ${field.field_name} to single select`, result);
}

async function dropColumns(fields, names) {
  for (const name of names) {
    const field = fields.find((item) => item.field_name === name);
    if (!field) continue;
    if (dryRun) {
      console.log(`  plan  drop unused column ${name}`);
      continue;
    }
    const removed = await call(() => client.bitable.appTableField.delete({
      path: { ...path, field_id: field.field_id },
    }));
    await report(`drop unused column ${name}`, removed);
  }
}

async function listViews() {
  const result = await call(() => client.bitable.appTableView.list({ path, params: { page_size: 100 } }));
  if (!result.ok) throw new Error(`view list failed: ${explainBitableError(result.code, result.message)}`);
  return result.data?.items ?? [];
}

async function removeView(views, name) {
  const view = views.find((item) => item.view_name === name);
  if (!view) return true;
  if (dryRun) {
    console.log(`  plan  delete view ${name}`);
    return true;
  }
  const removed = await call(() => client.bitable.appTableView.delete({ path: { ...path, view_id: view.view_id } }));
  return report(`delete view ${name}`, removed);
}

async function setHiddenFields(view, hiddenFields) {
  if (!view) return true;
  if (dryRun) {
    console.log(`  plan  hide ${hiddenFields.length} column(s) in ${view.view_name}`);
    return true;
  }
  const patched = await call(() => client.bitable.appTableView.patch({
    path: { ...path, view_id: view.view_id },
    data: { property: { hidden_fields: hiddenFields } },
  }));
  return report(`hide detail columns in ${view.view_name}`, patched);
}

async function setViewFilter(view, conditions) {
  if (!view?.view_id) return true;
  if (dryRun) {
    console.log(`  plan  filter ${view.view_name}`);
    return true;
  }
  const patched = await call(() => client.bitable.appTableView.patch({
    path: { ...path, view_id: view.view_id },
    data: { property: { filter_info: { conjunction: "or", conditions } } },
  }));
  return report(`filter ${view.view_name}`, patched);
}

async function ensureOverviewView(views, { name, hiddenFields }) {
  let view = views.find((item) => item.view_name === name);
  if (!view) {
    if (dryRun) {
      console.log(`  plan  create view ${name} (grid)`);
      view = { view_name: name, view_id: null };
    } else {
      const created = await call(() => client.bitable.appTableView.create({
        path,
        data: { view_name: name, view_type: "grid" },
      }));
      if (!report(`create view ${name}`, created)) return false;
      view = created.data?.view;
    }
  } else {
    console.log(`  skip  view ${name} already exists`);
  }
  return setHiddenFields(view, hiddenFields);
}

async function ensureProcessingView(views, { statusField, hiddenFields }) {
  const name = "处理中";
  let view = views.find((item) => item.view_name === name);
  if (!view) {
    if (dryRun) {
      console.log(`  plan  create view ${name} (kanban)`);
      view = { view_name: name, view_id: null };
    } else {
      const created = await call(() => client.bitable.appTableView.create({
        path,
        data: { view_name: name, view_type: "kanban" },
      }));
      if (!report(`create view ${name}`, created)) return false;
      view = created.data?.view;
    }
  } else {
    console.log(`  skip  view ${name} already exists`);
  }
  if (!view) return false;
  if (!await setHiddenFields(view, hiddenFields)) return false;
  if (statusField?.field_id) {
    const values = [STATUS_LABELS.in_progress, STATUS_LABELS.awaiting_approval];
    await setViewFilter(view, values.map((value) => ({
      field_id: statusField.field_id,
      operator: "is",
      value: JSON.stringify([value]),
      field_type: statusField.type,
    })));
  }
  return true;
}

async function deleteBlankRecords() {
  const blank = (await listRecords()).filter((record) => {
    const values = Object.values(record.fields ?? {});
    return values.every((value) => value === null || value === undefined || value === ""
      || (Array.isArray(value) && value.length === 0));
  });
  if (!blank.length) {
    console.log("  skip  no blank rows to remove");
    return true;
  }
  if (dryRun) {
    console.log(`  plan  delete ${blank.length} blank row(s)`);
    return true;
  }
  const deleted = await call(() => client.bitable.appTableRecord.batchDelete({
    path,
    data: { records: blank.map((record) => record.record_id) },
  }));
  return report(`delete ${blank.length} blank row(s)`, deleted);
}

console.log(`[setup] table ${tableId}${dryRun ? " (dry run)" : ""}`);

console.log("columns:");
await renameColumns(await listFields());

console.log("values:");
const legacyValues = await captureLegacyValues();

console.log("types:");
let fields = await listFields();
let byName = new Map(fields.map((field) => [field.field_name, field]));
await ensureSingleSelect(byName.get("状态"), STATUS_OPTIONS);
await ensureSingleSelect(byName.get("负责人"), OWNER_OPTIONS);
await applyTranslatedValues(legacyValues);

console.log("unused columns:");
await dropColumns(await listFields(), DROP_COLUMNS);

console.log("views:");
const views = await listViews();
for (const obsolete of ["进行中", "阻塞与风险", "已交付"]) {
  await removeView(views, obsolete);
}
fields = await listFields();
byName = new Map(fields.map((field) => [field.field_name, field]));
const hiddenFields = ["阶段", "交付物", "开始时间", "完成时间", "阻塞", "风险"]
  .map((name) => byName.get(name)?.field_id)
  .filter(Boolean);
await ensureOverviewView(views, { name: "全部状态", hiddenFields });
const processingHidden = ["任务编号", "项目", "阶段", "阻塞", "风险", "交付物", "开始时间", "更新时间", "完成时间"]
  .map((name) => byName.get(name)?.field_id)
  .filter(Boolean);
await ensureProcessingView(views, { statusField: byName.get("状态"), hiddenFields: processingHidden });

console.log("cleanup:");
await deleteBlankRecords();

const missing = BOARD_FIELD_SCHEMA.filter((field) => !byName.has(field.name)).map((field) => field.name);
console.log(`[setup] board columns: ${BOARD_FIELD_SCHEMA.length - missing.length}/${BOARD_FIELD_SCHEMA.length}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
console.log("[setup] done");
console.log("[setup] manual step the API cannot set: in the 看板 view set 分组 to 状态 and choose which fields the cards show (卡片配置).");
