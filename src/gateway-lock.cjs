// @ts-check
// 网关单实例锁（CommonJS，网关与 Electron 主进程共用）。
//
// 同一套飞书机器人凭据只能有一个长连接网关：两个网关同时在线时，飞书把每条消息、
// 每次卡片回调只投给其中一个，另一个进程里的待确认状态就会“点了没反应”。
// 原先的锁文件放在各自的数据目录下（logs/gateway.lock），命令行启动与桌面端启动
// 互相看不见。这里额外按机器人 App ID 在用户目录下加一把全局锁，不论从哪里启动都能发现对方。
const fs = require("node:fs");
const os = require("node:os");
const { dirname, join } = require("node:path");
const { feishuEnabled } = require("./feishu-mode.cjs");

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/** 锁内容兼容旧格式（只有 pid 数字）与新格式（JSON：pid、数据目录、启动时间）。 */
function readLock(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8").trim(); } catch { return null; }
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "number") return { pid: parsed };
    if (parsed && Number.isInteger(parsed.pid)) return parsed;
  } catch {}
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 ? { pid } : null;
}

/** 当前持有且仍存活的锁；没有或已失效返回 null。 */
function activeLock(file, selfPid = process.pid) {
  const lock = readLock(file);
  return lock && lock.pid !== selfPid && isAlive(lock.pid) ? lock : null;
}

function writeLock(file, info = {}) {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, cwd: process.cwd(), started_at: new Date().toISOString(), ...info }));
}

function releaseLock(file) {
  try {
    if (readLock(file)?.pid === process.pid) fs.unlinkSync(file);
  } catch {}
}

/** 按项目经理（没有则取第一个已配置角色）的 App ID 定位全局锁；未配置任何机器人时返回 null。 */
function globalLockFile(agents = [], env = process.env, home = process.env.PI_LOCK_DIR || join(os.homedir(), ".multyagent-feishu", "locks")) {
  // 关闭飞书时不连接机器人，也就不会与其他网关抢同一套机器人。
  if (!feishuEnabled(env)) return null;
  const ordered = [...agents].sort((a, b) => Number(b.key === "project_manager") - Number(a.key === "project_manager"));
  const appId = ordered.map((agent) => env[agent.appIdEnv]).find(Boolean);
  if (!appId) return null;
  return join(home, `${String(appId).replace(/[^A-Za-z0-9_-]/g, "_")}.lock`);
}

function describeLock(lock) {
  return `pid=${lock.pid}${lock.cwd ? `，数据目录 ${lock.cwd}` : ""}`;
}

module.exports = { activeLock, describeLock, globalLockFile, isAlive, readLock, releaseLock, writeLock };
