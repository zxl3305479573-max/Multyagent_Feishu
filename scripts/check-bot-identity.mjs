// 诊断脚本：查看每个飞书机器人自己的 open_id 与应用名。
// 群聊里「@ 谁谁才响应」的判定依赖这两个值，路由异常时先跑它核对。
//   node scripts/check-bot-identity.mjs
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Client } from "@larksuiteoapi/node-sdk";

const config = JSON.parse(await readFile(new URL("../config/agents.json", import.meta.url), "utf8"));

for (const definition of config.agents) {
  const appId = process.env[definition.appIdEnv];
  const appSecret = process.env[definition.appSecretEnv];
  if (!definition.enabled || !appId || !appSecret) {
    console.log(`[skip] ${definition.key}: missing credentials`);
    continue;
  }
  const client = new Client({ appId, appSecret });
  try {
    const response = await client.request({ url: "/open-apis/bot/v3/info", method: "GET" });
    const body = response?.data ?? response;
    console.log(JSON.stringify({
      key: definition.key,
      configuredName: definition.displayName,
      appName: body?.bot?.app_name || null,
      openId: body?.bot?.open_id || null,
    }));
  } catch (error) {
    console.error(`[error] ${definition.key}: ${error.message}`);
  }
}
