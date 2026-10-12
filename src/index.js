import "dotenv/config";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { Client, EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { createRunAgent } from "./handlers.js";
import { createCardActionHandler, createRoleHandler } from "./gateway.js";
import { createOrchestrator } from "./orchestrator.js";
import { TaskStore } from "./domain/task-store.js";
import { createEventLogger } from "./observability.js";
import { createBitableSync, createBoardEventSink, createCompactLogger, reconcileFields, resolveBitableTarget } from "./bitable-sync.js";
import { createBitableTraceSync, reconcileTraceFields } from "./bitable-trace-sync.js";
import { createBitableControl } from "./bitable-control.js";
import { configureTaskStore, setPaused } from "./tasks.js";
import { createDesktopHost } from "./desktop-host.js";
import { createDesktopTaskSubmitter } from "./desktop-task.js";
import { archiveProjectHistory, exportProjectSnapshot, restoreProjectHistory } from "./project-history.js";
import { createProjectRegistry } from "./project-registry.js";
import { createShutdown } from "./shutdown.js";
import { roleConfig } from "./role-config.cjs";
import { rotateEventLog } from "./event-log.js";

// 角色定义来自 config/roles/*.json；配置有误时在这里直接报错退出。
const config = { agents: roleConfig().agents };
const runAgent = createRunAgent();
const allowedChatId = process.env.FEISHU_ALLOWED_CHAT_ID || "";
const active = [];
const feishuClientLogger = createCompactLogger();
// Replaced by the board sink once the Bitable target is resolved; the arrow
// wrappers below read it at call time so ordering stays flexible.
let recordEvent;
let desktopHost = null;

// 单实例守卫：同一套应用凭据只允许一个长连接网关。
// 两个网关同时运行时，事件与卡片回调只会投给其中一个，
// 而待确认状态在内存里，点击就会落到没有状态的进程上，表现为「点了没反应」。
const lockFile = process.env.PI_LOCK_FILE || "logs/gateway.lock";
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
try {
  const held = Number(readFileSync(lockFile, "utf8").trim());
  if (held && held !== process.pid && alive(held)) {
    console.error(`[fatal] gateway already running (pid=${held}). 先停掉旧实例再启动，否则卡片回调会落到另一个进程而拿不到待确认状态。`);
    process.exit(1);
  }
} catch {
  // 无锁文件或内容不可读：按首次启动处理。
}
mkdirSync(dirname(lockFile), { recursive: true });
writeFileSync(lockFile, String(process.pid));

const lifecycle = createShutdown({ log: console, timeoutMs: Number(process.env.PI_SHUTDOWN_TIMEOUT_MS) || 10_000 });
lifecycle.installSignalHandlers();
function releaseLock() {
  try {
    if (Number(readFileSync(lockFile, "utf8").trim()) === process.pid) unlinkSync(lockFile);
  } catch {
  }
}
// 最先注册 → 最后执行：所有组件关闭后再释放单实例锁。
lifecycle.register("lock", releaseLock);

const orchestrator = createOrchestrator({
  runAgent,
  onEvent: (event) => recordEvent(event),
  approvalsFile: process.env.PI_APPROVALS_FILE || "runtime/approvals.json",
  checkpointFile: process.env.PI_CHECKPOINTS_FILE || "runtime/checkpoints.json",
});
const taskStore = new TaskStore(process.env.PI_DOMAIN_TASKS_FILE || "runtime/domain-tasks.json");
// 启动时显式加载：任务文件损坏会在这里报错并保留备份，而不是被空状态覆盖。
try {
  await taskStore.load();
} catch (error) {
  console.error(`[fatal] ${error.message}`);
  releaseLock();
  process.exit(1);
}
configureTaskStore(taskStore);
const eventsFile = process.env.PI_EVENTS_FILE || "runtime/events.jsonl";
// 事件日志超过阈值时在启动阶段归档（此时还没有并发写入）。进行中和最近 24 小时内
// 结束的任务事件会带到新文件，保证看板与 Trace 重放仍能还原它们。
try {
  const rotateBytes = (Number(process.env.PI_EVENTS_ROTATE_MB) || 50) * 1024 * 1024;
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const tasksById = new Map((await taskStore.list()).map((task) => [task.task_id, task]));
  const rotation = await rotateEventLog({
    file: eventsFile,
    maxBytes: rotateBytes,
    keepTask: (rootTaskId) => {
      const task = tasksById.get(rootTaskId);
      if (!task) return false;
      const status = task.status_snapshot?.status || task.status;
      return !terminal.has(status) || Date.now() - Date.parse(task.updated_at || 0) < 24 * 60 * 60 * 1000;
    },
  });
  if (rotation.rotated) console.log(`[events] archived ${(rotation.size / 1048576).toFixed(1)} MB to ${rotation.archiveFile}; carried ${rotation.carried} active event(s)`);
} catch (error) {
  console.warn(`[events] rotation skipped: ${error.message}`);
}
const eventLogger = createEventLogger(eventsFile, { taskStore });
recordEvent = eventLogger;
await eventLogger({ type: "gateway_started", active_pid: process.pid, lock_file: lockFile });
// 兜底：未经过优雅退出（如未捕获异常）时也尽量释放锁；exit 回调只能做同步操作。
process.on("exit", releaseLock);
lifecycle.register("task store", () => taskStore.flush());
lifecycle.register("stop event", () => eventLogger({ type: "gateway_stopped", active_pid: process.pid }));
const migration = await taskStore.migrateLegacyFile(process.env.PI_LEGACY_TASKS_FILE || "runtime/tasks.json");
if (migration.imported) console.log(`[tasks] imported ${migration.imported} legacy task(s) into ${taskStore.file}`);
await taskStore.recoverRunning();

// 群聊路由需要知道「@ 的是不是机器人」，以及「@ 的是不是我自己」。
// @ 消息里的 name 是飞书应用名（bot/v3/info 的 app_name），与配置里的显示名可能不同，两者都收。
async function resolveBotIdentity(client, key) {
  try {
    const response = await client.request({ url: "/open-apis/bot/v3/info", method: "GET" });
    const body = response?.data ?? response;
    const openId = body?.bot?.open_id || null;
    const appName = body?.bot?.app_name || "";
    if (!openId) console.warn(`[warn] ${key}: bot/v3/info 未返回 open_id，@ 识别退化为按显示名匹配`);
    return { openId, appName };
  } catch (error) {
    console.warn(`[warn] ${key}: bot/v3/info 调用失败（${error.message}），@ 识别退化为按显示名匹配`);
    return { openId: null, appName: "" };
  }
}

const prepared = [];
for (const definition of config.agents) {
  const appId = process.env[definition.appIdEnv];
  const appSecret = process.env[definition.appSecretEnv];
  if (!definition.enabled || !appId || !appSecret) {
    console.log(`[skip] ${definition.key}: missing credentials`);
    continue;
  }
  const client = new Client({ appId, appSecret, logger: feishuClientLogger });
  prepared.push({ definition, agent: { ...definition, appId }, client, appId, appSecret, identity: await resolveBotIdentity(client, definition.key) });
}

const botNames = [...new Set([
  ...config.agents.map((item) => item.displayName),
  ...prepared.map((item) => item.identity.appName),
].filter(Boolean))];

const bitableWikiToken = process.env.FEISHU_BITABLE_WIKI_TOKEN || "";
const bitableAppToken = process.env.FEISHU_BITABLE_APP_TOKEN || "";
const bitableTableId = process.env.FEISHU_BITABLE_TABLE_ID || "";
const bitableTraceTableId = process.env.FEISHU_BITABLE_TRACE_TABLE_ID || "";
let bitableControl = null;
let bitableTraceProjection = null;
const boardOwner = prepared.find((item) => item.definition.key === "project_manager");
if (!boardOwner) {
  if (bitableTableId || bitableTraceTableId) console.warn("[bitable] control plane disabled: project-manager credentials are required; no other role will use Bitable");
} else if (!bitableTableId || (!bitableWikiToken && !bitableAppToken)) {
  console.log("[bitable] dashboard sync disabled: set FEISHU_BITABLE_TABLE_ID plus FEISHU_BITABLE_WIKI_TOKEN or FEISHU_BITABLE_APP_TOKEN");
} else {
  try {
    const appToken = await resolveBitableTarget({
      client: boardOwner.client,
      wikiToken: bitableWikiToken,
      appToken: bitableAppToken,
    });
    const autoInit = process.env.FEISHU_BITABLE_AUTO_INIT !== "false";
    let boardSync = null;
    let traceSync = null;
    let reconcile;
    try {
      reconcile = await reconcileFields(boardOwner.client, {
        appToken,
        tableId: bitableTableId,
        autoInit,
      });
    } catch (error) {
      reconcile = { created: [], failed: ["<schema unavailable>"], available: [] };
      console.warn(`[bitable] dashboard sync disabled: ${error.message}`);
    }
    if (reconcile.failed.length) {
      console.warn(`[bitable] dashboard fields unavailable: ${reconcile.failed.join(", ")}. Existing fields will continue syncing.`);
    }
    boardSync = reconcile.available?.length
      ? createBitableSync({ client: boardOwner.client, appToken, tableId: bitableTableId, availableFields: reconcile.available })
      : null;
    if (boardSync) {
      bitableControl = createBitableControl({
        client: boardOwner.client,
        appToken,
        tableId: bitableTableId,
        intervalMs: Number(process.env.FEISHU_BITABLE_CONTROL_POLL_MS) || 5000,
        log: console,
        onCommand: async ({ command, taskId }) => {
          let result;
          if (command === "pause") {
            const task = await setPaused(taskId, true);
            result = task ? "已暂停：当前 Agent 完成本轮后将停在派发检查点" : "未找到任务，未执行暂停";
          } else if (command === "resume") {
            const count = await orchestrator.resumeTask(taskId);
            result = count === null ? "未找到任务，未执行恢复" : `已恢复：继续处理 ${count} 个待执行检查点`;
          } else {
            const outcome = await orchestrator.terminateTask(taskId);
            result = outcome.terminated ? `已终止：中断 ${outcome.aborted} 个活动 Agent` : "未找到任务，未执行终止";
          }
          await recordEvent({ type: "control_applied", task_id: taskId, command, result });
          return { result };
        },
      });

      console.log(`[bitable] task board and controls ready (${reconcile.created.length ? `created ${reconcile.created.length} field(s)` : "schema ready"})`);
    }
    if (bitableTraceTableId) {
      try {
        const traceReconcile = await reconcileTraceFields(boardOwner.client, { appToken, tableId: bitableTraceTableId, autoInit });
        if (traceReconcile.failed.length) console.warn(`[bitable-trace] sync disabled: missing fields ${traceReconcile.failed.join(", ")}`);
        else {
          traceSync = createBitableTraceSync({ client: boardOwner.client, appToken, tableId: bitableTraceTableId, log: console });
          bitableTraceProjection = traceSync;
          console.log(`[bitable-trace] execution trace syncing (${traceReconcile.created.length ? `created ${traceReconcile.created.length} field(s)` : "schema ready"})`);
        }
      } catch (error) {
        console.warn(`[bitable-trace] sync disabled: ${error.message}`);
      }
    }
    recordEvent = createBoardEventSink({ logger: eventLogger, sync: boardSync, trace: traceSync });
  } catch (error) {
    console.warn(`[bitable] dashboard sync disabled: ${error.message}`);
  }
}

if (bitableTraceProjection) {
  void bitableTraceProjection.flush();
  lifecycle.register("bitable trace", () => bitableTraceProjection.flush());
}

if (bitableControl) {
  bitableControl.start();
  lifecycle.register("bitable control", () => bitableControl.stop());
}

// Desktop control is deliberately loopback-only. Electron reads the generated
// token from the runtime file and uses the same gateway task/event sources as
// Feishu; no second orchestration or task store is created.
if (process.env.PI_DESKTOP_CONTROL !== "false") {
  const desktopToken = process.env.PI_DESKTOP_TOKEN || randomBytes(32).toString("hex");
  const desktopTokenFile = process.env.PI_DESKTOP_TOKEN_FILE || "runtime/desktop-session.token";
  const projectRegistry = createProjectRegistry({ file: process.env.PI_PROJECTS_FILE || "runtime/projects.json" });
  await mkdir(dirname(desktopTokenFile), { recursive: true });
  const gatewayRecordEvent = recordEvent;
  const publishRecordEvent = async (event) => {
    const entry = await gatewayRecordEvent(event);
    desktopHost?.publish(entry);
    return entry;
  };
  const submitTask = boardOwner?.agent
    ? createDesktopTaskSubmitter({
      taskStore,
      orchestrator,
      runAgent,
      projectManagerAgent: boardOwner.agent,
      recordEvent: publishRecordEvent,
    })
    : null;
  const exportProject = async ({ projectName, outputFile } = {}) => {
    const project = String(projectName || "").trim();
    if (!project) throw new Error("projectName is required");
    const target = outputFile || `runtime/exports/${project}-${Date.now()}.json`;
    const result = await exportProjectSnapshot({ project, taskStore, eventsFile: eventsFile, outputFile: target });
    await publishRecordEvent({ type: "project_exported", project_name: project, output_file: result.output_file, artifact_count: result.artifact_refs.length, channel: "desktop" });
    return { projectName: project, outputFile: result.output_file, taskCount: result.tasks.length, eventCount: result.events.length, artifactCount: result.artifact_refs.length };
  };
  const cleanupHistory = async ({ projectName, keep = 1000 } = {}) => {
    const project = String(projectName || "").trim();
    if (!project) throw new Error("projectName is required");
    const result = await archiveProjectHistory({ project, keep, eventsFile: eventsFile, archiveFile: `runtime/events-archive/${project}.jsonl` });
    await publishRecordEvent({ type: "project_history_archived", project_name: project, archived_count: result.archived, kept_count: result.kept, archive_file: result.archiveFile, channel: "desktop" });
    return result;
  };
  const restoreHistory = async ({ projectName } = {}) => {
    const project = String(projectName || "").trim();
    if (!project) throw new Error("projectName is required");
    const result = await restoreProjectHistory({ project, eventsFile: eventsFile, archiveFile: `runtime/events-archive/${project}.jsonl` });
    await publishRecordEvent({ type: "project_history_restored", project_name: project, restored_count: result.restored, archive_file: result.archiveFile, channel: "desktop" });
    return result;
  };
  const createProject = async ({ projectName, storagePath } = {}) => {
    const project = await projectRegistry.create({ name: projectName, storagePath });
    await publishRecordEvent({ type: "project_created", project_name: project.name, storage_path: project.storagePath, channel: "desktop" });
    return { projectName: project.name, storagePath: project.storagePath };
  };
  desktopHost = createDesktopHost({
    token: desktopToken,
    eventsFile: eventsFile,
    taskStore,
    orchestrator,
    agents: config.agents.map(({ key, displayName, enabled }) => ({ key, displayName, enabled })),
    recordEvent: publishRecordEvent,
    submitTask,
    createProject,
    listProjects: async (taskProjects) => (await projectRegistry.list(taskProjects)).map((item) => item.name),
    exportProject,
    cleanupHistory,
    restoreHistory,
    host: "127.0.0.1",
    port: Number(process.env.PI_DESKTOP_PORT) || 0,
  });
  const address = await desktopHost.listen();
  await writeFile(desktopTokenFile, `${JSON.stringify({ token: desktopToken, port: address.port })}\n`, { encoding: "utf8" });
  recordEvent = publishRecordEvent;
  console.log(`[desktop] control ready ws://127.0.0.1:${address.port}/desktop token=${desktopTokenFile}`);
  lifecycle.register("desktop control", async () => {
    await desktopHost?.close();
    // 令牌随进程失效，删掉文件避免桌面端读到过期端口。
    try { unlinkSync(desktopTokenFile); } catch {}
  });
}

for (const { definition, agent, client, appId, appSecret, identity } of prepared) {
  orchestrator.registerRole(agent, client);
  const handler = createRoleHandler({
    agent,
    client,
    runAgent,
    orchestrator,
    taskStore,
    botNames,
    selfOpenId: identity.openId,
    selfName: identity.appName,
    onEvent: (event) => recordEvent(event),
    isAllowedChat: (chatId) => !allowedChatId || chatId === allowedChatId,
  });
  const cardActionHandler = createCardActionHandler({ orchestrator, client, agent, onEvent: (event) => recordEvent(event) });
  const wsClient = new WSClient({
    appId,
    appSecret,
    loggerLevel: LoggerLevel.info,
    onError: (error) => console.error(`[error] ${definition.key} (${definition.displayName}) connection failed: ${error.message}`),
  });
  wsClient.start({
    eventDispatcher: new EventDispatcher({}).register({
      "im.message.receive_v1": handler,
      "card.action.trigger": cardActionHandler,
    }),
  });
  lifecycle.register(`feishu ${definition.key}`, () => wsClient.close?.({ force: true }));
  active.push(definition.key);
  console.log(`[start] ${definition.key} (${definition.displayName}) connected`);
}

if (!active.length) {
  console.error("No configured Feishu bots. Copy .env.example to .env and fill at least one App ID and App Secret.");
  if (process.env.PI_DESKTOP_CONTROL === "false") process.exitCode = 1;
} else {
  console.log(`[ready] pid=${process.pid} active agents: ${active.join(", ")}`);
}
