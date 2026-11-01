// @ts-check
// 飞书接入开关（CommonJS，网关与 Electron 主进程共用）。
//
// FEISHU_ENABLED=false 时网关完全不连接飞书：不创建机器人长连接、不同步多维表格、
// 不加按 App ID 的全局锁，即使凭据已保存也不使用。桌面端任务照常运行。
// 未设置时默认开启，保持旧行为（有凭据的角色自动连接）。
function feishuEnabled(env = process.env) {
  const value = String(env.FEISHU_ENABLED ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(value);
}

module.exports = { feishuEnabled };
