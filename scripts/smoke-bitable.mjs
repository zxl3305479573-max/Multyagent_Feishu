// Live check for the Bitable task board: resolves the target, reconciles the
// additive field schema, then proves one task maps to exactly one row that is
// updated in place. It leaves the smoke row behind on purpose; delete it from
// the table when you are done inspecting it.
import "dotenv/config";
import { Client } from "@larksuiteoapi/node-sdk";
import { createBitableSync, createCompactLogger, reconcileFields, resolveBitableTarget } from "../src/bitable-sync.js";
import { KEY_FIELD } from "../src/domain/bitable-board.js";

const appId = process.env.FEISHU_PROJECT_MANAGER_APP_ID;
const appSecret = process.env.FEISHU_PROJECT_MANAGER_APP_SECRET;
const wikiToken = process.env.FEISHU_BITABLE_WIKI_TOKEN;
const explicitAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;
const tableId = process.env.FEISHU_BITABLE_TABLE_ID;

if (!appId || !appSecret) {
  console.error("missing FEISHU_PROJECT_MANAGER_APP_ID / FEISHU_PROJECT_MANAGER_APP_SECRET");
  process.exit(1);
}
if (!tableId || (!wikiToken && !explicitAppToken)) {
  console.error("missing FEISHU_BITABLE_TABLE_ID and a wiki or app token");
  process.exit(1);
}

const client = new Client({ appId, appSecret, logger: createCompactLogger() });
const appToken = await resolveBitableTarget({ client, wikiToken, appToken: explicitAppToken });
console.log(`[smoke] resolved app token for table ${tableId}`);

const reconcile = await reconcileFields(client, {
  appToken,
  tableId,
  autoInit: process.env.FEISHU_BITABLE_AUTO_INIT !== "false",
});
console.log(`[smoke] fields created: ${reconcile.created.length}, still missing: ${reconcile.failed.length}`);
if (reconcile.failed.length) {
  console.error(`[smoke] missing fields: ${reconcile.failed.join(", ")}`);
  process.exit(1);
}

const smokeTaskId = `SMOKE-${Date.now()}`;
const sync = createBitableSync({ client, appToken, tableId, flushDelayMs: 0 });
const base = Date.now();

sync.handleEvent({ type: "task_created", task_id: smokeTaskId, agent: "project_manager", chat_id: "smoke-chat", text: "看板同步自检", timestamp: new Date(base).toISOString() });
sync.handleEvent({ type: "task_started", task_id: smokeTaskId, agent: "project_manager", project_name: "smoke", timestamp: new Date(base + 1000).toISOString() });
await sync.whenIdle();
console.log(`[smoke] after first flush: created=${sync.stats.created} updated=${sync.stats.updated} failed=${sync.stats.failed}`);

sync.handleEvent({ type: "delivery_received", task_id: `${smokeTaskId}:architect`, parent_task_id: smokeTaskId, agent: "architect", blockers: ["自检阻塞项"], risks: ["自检风险项"], artifact_paths: ["workspace/smoke/artifacts/report.md"], summary: "自检交付", timestamp: new Date(base + 2000).toISOString() });
sync.handleEvent({ type: "approval_required", task_id: `${smokeTaskId}:architect`, parent_task_id: smokeTaskId, agent: "architect", chat_id: "smoke-chat", timestamp: new Date(base + 3000).toISOString() });
await sync.whenIdle();
console.log(`[smoke] after second flush: created=${sync.stats.created} updated=${sync.stats.updated} failed=${sync.stats.failed}`);

const found = await client.bitable.appTableRecord.search({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 10 },
  data: {
    filter: {
      conjunction: "and",
      conditions: [{ field_name: KEY_FIELD, operator: "is", value: [smokeTaskId] }],
    },
  },
});
if (found.code !== 0) {
  console.error(`[smoke] verification search failed code=${found.code} msg=${found.msg}`);
  process.exit(1);
}
const items = found.data?.items ?? [];
console.log(`[smoke] rows for ${smokeTaskId}: ${items.length}`);
if (items.length !== 1) {
  console.error("[smoke] expected exactly one row per task");
  process.exit(1);
}

const fields = items[0].fields ?? {};
console.log(`[smoke] 状态=${JSON.stringify(fields["状态"])} 负责人=${JSON.stringify(fields["负责人"])} 阻塞=${JSON.stringify(fields["阻塞"])}`);
console.log("[smoke] ok: one task maps to one row and is updated in place");
console.log(`[smoke] delete the ${smokeTaskId} row from the table when finished`);
