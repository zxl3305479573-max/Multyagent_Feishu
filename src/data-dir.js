// 共享数据根目录。
//
// 网关的状态全部用相对路径保存（runtime/、workspace/、logs/），以工作目录为根。
// 桌面端把网关的工作目录设为自己的数据目录；命令行 `npm start` 默认用仓库目录，两边数据互不相通。
// 设置 PI_DATA_DIR 后网关启动即切换到该目录，命令行与桌面端就能共用同一份任务、事件和项目。
// 由 src/index.js 紧跟 dotenv 导入：.env 先从仓库目录读取，再切换目录。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function applyDataDir(env = process.env) {
  const configured = String(env.PI_DATA_DIR || "").trim();
  if (!configured) return null;
  const target = resolve(configured.replace(/%([^%]+)%/g, (match, name) => env[name] ?? match));
  mkdirSync(target, { recursive: true });
  if (resolve(process.cwd()) !== target) process.chdir(target);
  return target;
}

const dataDir = applyDataDir();
if (dataDir) console.log(`[data] using shared data directory ${dataDir}`);
