import "dotenv/config";
import { Client } from "@larksuiteoapi/node-sdk";

const args = process.argv.slice(2);
const readArg = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const appToken = readArg("app-token") ?? process.env.FEISHU_BITABLE_APP_TOKEN;
const tableId = readArg("table-id") ?? process.env.FEISHU_BITABLE_TABLE_ID;
const appId = process.env.FEISHU_PROJECT_MANAGER_APP_ID;
const appSecret = process.env.FEISHU_PROJECT_MANAGER_APP_SECRET;
const writeTest = args.includes("--write");

if (!appId || !appSecret) {
  console.error("缺少 FEISHU_PROJECT_MANAGER_APP_ID 或 FEISHU_PROJECT_MANAGER_APP_SECRET");
  process.exit(1);
}
if (!appToken || !tableId) {
  console.error("用法: node scripts/check-bitable.mjs --app-token <token> --table-id <id> [--write]");
  process.exit(1);
}

const client = new Client({ appId, appSecret });

const fields = await client.bitable.appTableField.list({
  path: { app_token: appToken, table_id: tableId },
  params: { page_size: 100 },
});
if (fields.code !== 0) {
  console.error(`读取字段失败 code=${fields.code} msg=${fields.msg}`);
  console.error("常见原因：应用未加为该表格协作者，或权限未发布，或 app_token/table_id 不正确。");
  process.exit(1);
}

const names = (fields.data?.items ?? []).map((item) => item.field_name);
console.log(`字段 ${names.length} 个: ${names.join(", ")}`);

if (!writeTest) {
  console.log("只读检查通过。加 --write 可进一步验证写入权限。");
  process.exit(0);
}

const created = await client.bitable.appTableRecord.create({
  path: { app_token: appToken, table_id: tableId },
  data: {
    fields: {
      task_id: `CHECK-${Date.now()}`,
      title: "权限自检",
      status: "completed",
    },
  },
});
if (created.code !== 0) {
  console.error(`写入失败 code=${created.code} msg=${created.msg}`);
  console.error("若提示字段不存在，请把自检字段名改成你表中实际的字段名。");
  process.exit(1);
}

console.log(`写入成功 record_id=${created.data?.record?.record_id}`);
console.log("自检完成后请在多维表格中删除这条记录。");
