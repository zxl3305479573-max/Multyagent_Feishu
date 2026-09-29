// 诊断脚本：验证机器人能否上传图片（卡片内嵌图的前置条件）。
// 只上传一张 1x1 透明 PNG，不会往群里发任何消息。
//   node scripts/check-image-upload.mjs [role]   默认 project_manager
import "dotenv/config";
import { Client } from "@larksuiteoapi/node-sdk";

// 1x1 透明 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const role = (process.argv[2] || "project_manager").toUpperCase();
const appId = process.env[`FEISHU_${role}_APP_ID`];
const appSecret = process.env[`FEISHU_${role}_APP_SECRET`];
if (!appId || !appSecret) {
  console.error(`[error] 缺少 FEISHU_${role}_APP_ID / _APP_SECRET`);
  process.exit(1);
}

const client = new Client({ appId, appSecret });
try {
  const response = await client.im.image.create({ data: { image_type: "message", image: PNG } });
  const key = response?.data?.image_key || response?.image_key || null;
  console.log(JSON.stringify({ role, ok: Boolean(key), imageKey: key }));
  if (!key) console.error("[error] 上传返回里没有 image_key，请检查权限是否已发布生效");
} catch (error) {
  const detail = error?.response?.data ?? { message: error.message };
  console.error(JSON.stringify({ role, ok: false, detail }));
}
