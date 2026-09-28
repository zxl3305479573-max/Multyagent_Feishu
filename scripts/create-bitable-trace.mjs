import "dotenv/config";
import { Client } from "@larksuiteoapi/node-sdk";
import { createCompactLogger, resolveBitableTarget } from "../src/bitable-sync.js";
import { TRACE_FIELD_SCHEMA } from "../src/domain/trace.js";

const appId = process.env.FEISHU_PROJECT_MANAGER_APP_ID;
const appSecret = process.env.FEISHU_PROJECT_MANAGER_APP_SECRET;
const wikiToken = process.env.FEISHU_BITABLE_WIKI_TOKEN;
const sourceAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
const boardTableId = process.env.FEISHU_BITABLE_TABLE_ID;
const traceName = process.env.FEISHU_BITABLE_TRACE_TABLE_NAME || "执行 Trace";

if (!appId || !appSecret || !boardTableId || (!wikiToken && !sourceAppToken)) {
  throw new Error("缺少项目经理凭据或任务看板配置");
}

const client = new Client({ appId, appSecret, logger: createCompactLogger() });
const appToken = await resolveBitableTarget({ client, wikiToken, appToken: sourceAppToken });
const path = { app_token: appToken };

async function call(fn, label) {
  try {
    const result = await fn();
    if ((result?.code ?? 0) !== 0) throw new Error(`${label}: code=${result.code} ${result.msg || ""}`);
    return result.data || {};
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

const tables = await call(() => client.bitable.appTable.list({ path, params: { page_size: 100 } }), "读取数据表");
let trace = (tables.items || []).find((item) => item.name === traceName || item.table_name === traceName);
if (!trace) {
  const created = await call(() => client.bitable.appTable.create({
    path,
    data: {
      table: {
        name: traceName,
        default_view_name: "表格视图",
        fields: TRACE_FIELD_SCHEMA.map((field) => ({
          field_name: field.name,
          type: field.type,
          ui_type: field.ui_type,
          ...(field.property ? { property: field.property } : {}),
        })),
      },
    },
  }), "创建 Trace 表");
  trace = created.table || created;
  console.log(`[bitable] created ${traceName}: ${trace.table_id || trace.tableId}`);
} else {
  console.log(`[bitable] found existing ${traceName}: ${trace.table_id}`);
}

const traceTableId = trace?.table_id || trace?.tableId;
if (!traceTableId) throw new Error("飞书未返回 Trace 表 ID");

const envPath = ".env";
const fs = await import("node:fs/promises");
let env = await fs.readFile(envPath, "utf8");
if (/^FEISHU_BITABLE_TRACE_TABLE_ID=/m.test(env)) {
  env = env.replace(/^FEISHU_BITABLE_TRACE_TABLE_ID=.*$/m, `FEISHU_BITABLE_TRACE_TABLE_ID=${traceTableId}`);
} else {
  env += `\nFEISHU_BITABLE_TRACE_TABLE_ID=${traceTableId}\n`;
}
await fs.writeFile(envPath, env);
console.log(`[bitable] wrote FEISHU_BITABLE_TRACE_TABLE_ID to ${envPath}`);
