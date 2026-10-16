#!/usr/bin/env node
// 把命令行网关的数据（仓库下 runtime/、workspace/）合并进共享数据目录（默认桌面端目录），
// 之后命令行与桌面端都设置同一个 PI_DATA_DIR，只保留一份任务、事件和项目。
//
// 用法：
//   node scripts/merge-data-dir.mjs                 预览（不写任何文件）
//   node scripts/merge-data-dir.mjs --apply         执行合并
//   可选 --from <源目录>（默认仓库根目录）、--to <目标目录>（默认 PI_DATA_DIR，否则开发版桌面端目录 %APPDATA%/Electron）
//
// 合并规则：
//   - runtime/domain-tasks.json：按 task_id 合并，同一任务保留 updated_at 较新的一份；索引类字段目标优先。
//   - runtime/events.jsonl：按 event_id 去重后按时间排序。
//   - workspace/<项目>：目标没有的项目建目录联接（junction）指向源目录，文件不搬动；并登记到 runtime/projects.json。
//   - approvals.json / checkpoints.json 是运行中的待确认状态，不合并（源里有未处理项时给出提示）。
// 执行前要求两边网关都已停止；目标里会被改写的文件先备份到 runtime/merge-backup-<时间>/。
import { copyFile, lstat, mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeLock, describeLock, globalLockFile } from "../src/gateway-lock.cjs";
import { roleConfig } from "../src/role-config.cjs";
import { writeFileAtomic } from "../src/atomic-file.cjs";

const PROJECT_NAME = /^[a-z][a-z0-9-]{1,63}$/;
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

// 开发模式下桌面端（electron desktop/electron/main.cjs）的 userData 目录。
function defaultDesktopDataDir() {
  if (process.platform === "win32") return join(homedir(), "AppData", "Roaming", "Electron");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Electron");
  return join(homedir(), ".config", "Electron");
}

function parseArgs(argv) {
  const args = { apply: false, from: repoRoot, to: process.env.PI_DATA_DIR || defaultDesktopDataDir() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--apply") args.apply = true;
    else if (argv[i] === "--from") args.from = argv[++i];
    else if (argv[i] === "--to") args.to = argv[++i];
    else throw new Error(`未知参数：${argv[i]}`);
  }
  if (!args.to) throw new Error("请用 --to 指定目标数据目录");
  return { ...args, from: resolve(args.from), to: resolve(args.to) };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw new Error(`${file} 无法解析：${error.message}`); }
}

async function readEvents(file) {
  let text;
  try { text = await readFile(file, "utf8"); } catch { return []; }
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

async function listProjectDirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && PROJECT_NAME.test(entry.name))
      .map((entry) => entry.name);
  } catch { return []; }
}

const emptyTasks = () => ({ tasks: {}, byIdempotencyKey: {}, aliases: {}, recent: {} });

export function mergeTaskStates(source, target) {
  const merged = { ...emptyTasks(), ...target, tasks: { ...target.tasks } };
  let added = 0; let updated = 0;
  for (const [id, task] of Object.entries(source.tasks || {})) {
    const existing = merged.tasks[id];
    if (!existing) { merged.tasks[id] = task; added += 1; continue; }
    if (Date.parse(task.updated_at || 0) > Date.parse(existing.updated_at || 0)) { merged.tasks[id] = task; updated += 1; }
  }
  for (const key of ["byIdempotencyKey", "aliases", "recent"]) merged[key] = { ...(source[key] || {}), ...(target[key] || {}) };
  return { merged, added, updated };
}

export function mergeEventLists(source, target) {
  // 早期事件没有 event_id，用整条内容作去重键，重复执行合并也不会把它们再写一遍。
  const keyOf = (event) => event.event_id || JSON.stringify(event);
  const seen = new Set(target.map(keyOf));
  const fresh = source.filter((event) => !seen.has(keyOf(event)));
  const time = (event) => Date.parse(event.timestamp || "") || 0;
  // 稳定排序：同一时间戳保持原有先后（目标在前）。
  const merged = [...target, ...fresh].map((event, index) => ({ event, index }))
    .sort((a, b) => time(a.event) - time(b.event) || a.index - b.index)
    .map((item) => item.event);
  return { merged, added: fresh.length };
}

function assertStopped(dirs) {
  const problems = [];
  for (const dir of dirs) {
    const lock = activeLock(join(dir, "logs", "gateway.lock"));
    if (lock) problems.push(`${dir} 的网关仍在运行（${describeLock(lock)}）`);
  }
  const botLock = globalLockFile(roleConfig().agents);
  const held = botLock && activeLock(botLock);
  if (held) problems.push(`飞书机器人网关仍在运行（${describeLock(held)}）`);
  if (problems.length) throw new Error(`请先停止所有网关（关闭桌面端、停止 npm start）再合并：\n  - ${problems.join("\n  - ")}`);
}

async function main() {
  const { apply, from, to } = parseArgs(process.argv.slice(2));
  if (from === to) throw new Error("源目录与目标目录相同，无需合并");
  console.log(`源目录：${from}\n目标目录：${to}\n模式：${apply ? "执行合并" : "预览（加 --apply 执行）"}\n`);

  const tasksFile = (dir) => join(dir, "runtime", "domain-tasks.json");
  const eventsFile = (dir) => join(dir, "runtime", "events.jsonl");
  const registryFile = join(to, "runtime", "projects.json");

  const tasks = mergeTaskStates(await readJson(tasksFile(from), emptyTasks()), await readJson(tasksFile(to), emptyTasks()));
  const events = mergeEventLists(await readEvents(eventsFile(from)), await readEvents(eventsFile(to)));
  const registry = await readJson(registryFile, { projects: {} });
  registry.projects ||= {};
  const targetProjects = new Set([...await listProjectDirs(join(to, "workspace")), ...Object.keys(registry.projects)]);
  const sourceProjects = await listProjectDirs(join(from, "workspace"));
  const linkProjects = sourceProjects.filter((name) => !targetProjects.has(name));
  const conflicts = sourceProjects.filter((name) => targetProjects.has(name));

  console.log(`任务：新增 ${tasks.added}，以较新版本覆盖 ${tasks.updated}，合并后共 ${Object.keys(tasks.merged.tasks).length}`);
  console.log(`事件：新增 ${events.added}，合并后共 ${events.merged.length}`);
  console.log(`项目：联接 ${linkProjects.length} 个${linkProjects.length ? `（${linkProjects.join("、")}）` : ""}`);
  if (conflicts.length) console.log(`  跳过同名项目 ${conflicts.join("、")}：目标里已存在，需要的话请手动合并目录内容`);
  const pending = Object.keys((await readJson(join(from, "runtime", "approvals.json"), {})).pending || {}).length;
  if (pending) console.log(`提示：源目录有 ${pending} 个未处理的确认卡片，不会迁移；合并后这些卡片点击将不再生效。`);

  if (!apply) { console.log("\n预览完成，未写入任何文件。"); return; }
  assertStopped([from, to]);

  const backupDir = join(to, "runtime", `merge-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(backupDir, { recursive: true });
  for (const file of [tasksFile(to), eventsFile(to), registryFile]) if (existsSync(file)) await copyFile(file, join(backupDir, file.split(/[\\/]/).pop()));

  await writeFileAtomic(tasksFile(to), `${JSON.stringify(tasks.merged, null, 2)}\n`);
  await writeFileAtomic(eventsFile(to), events.merged.length ? `${events.merged.map((event) => JSON.stringify(event)).join("\n")}\n` : "");
  await mkdir(join(to, "workspace"), { recursive: true });
  for (const name of linkProjects) {
    const storagePath = join(from, "workspace", name);
    const link = join(to, "workspace", name);
    try { await lstat(link); continue; } catch {}
    await symlink(storagePath, link, process.platform === "win32" ? "junction" : "dir");
    registry.projects[name] = { name, storagePath, createdAt: new Date().toISOString() };
  }
  await writeFileAtomic(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`\n合并完成。原文件已备份到 ${backupDir}`);
  console.log(`下一步：在仓库 .env 中加入 PI_DATA_DIR=${to}，之后 npm start 与桌面端共用这份数据（同一时间只运行其中一个）。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[merge] ${error.message}`); process.exitCode = 1; });
}
