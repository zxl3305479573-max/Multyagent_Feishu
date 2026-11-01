// 工单收件箱：GitHub Issues → 项目经理 → 结果回写。
//
// - 工单源（source）：一个仓库对应一个本地项目，可选标签/指派人过滤、定时拉单与自动关单。
// - 派发：工单正文、附图（先下载到项目目录）、用户补充说明拼成任务描述，交给项目经理；
//   幂等键 ticket:github:<repo>#<n> 保证重复拉取不会建出第二个任务。
// - 回写：根任务结束时把项目经理汇总与测试验收结论评论到 issue；开启自动关单且验收通过（或无测试环节）才关闭。
// - 定时拉单：按优先级门槛挑出未处理的工单；需要人工确认时先推飞书卡片，点“交给项目经理”才开工。
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readJsonFile, writeFileAtomic } from "../atomic-file.cjs";
import { assertRepo } from "./github.js";
import { downloadImages, extractImageUrls } from "./images.js";
import { PULL_THRESHOLDS, byPriority, matchesThreshold } from "./priority.js";

const HOUR_MS = 60 * 60 * 1000;
const PROJECT_NAME = /^[a-z][a-z0-9-]{1,63}$/;
const MAX_PER_PULL = 5;
const rootOf = (taskId) => String(taskId || "").split(":")[0];
const clip = (value, max) => String(value ?? "").trim().slice(0, max);
const keyOf = (repo, number) => `${repo}#${Number(number)}`;
const VERDICT_TEXT = { pass: "通过", fail: "未通过", skip: "跳过" };
const STATUS_TEXT = { completed: "已完成", failed: "失败", cancelled: "已终止" };

export function buildTicketPrompt({ repo, ticket, note = "", images = [] }) {
  const lines = [
    `来自 GitHub 工单 ${repo}#${ticket.number}：${ticket.title}`,
    `链接：${ticket.url}`,
    `优先级：${ticket.priority.label}${ticket.labels.length ? `（标签：${ticket.labels.join("、")}）` : ""}`,
    "",
    "—— 工单描述 ——",
    clip(ticket.body, 5000) || "（无描述）",
  ];
  if (note.trim()) lines.push("", "—— 用户补充 ——", clip(note, 1000));
  if (images.length) {
    lines.push("", "附图（已下载到项目目录，可直接读取）：");
    images.forEach((item, index) => lines.push(`  ${index + 1}. ${item.path || `[下载失败：${item.error}] ${item.url}`}`));
  }
  lines.push(
    "",
    "请先确认范围再规划：新需求按阶段派发；已明确的缺陷直接派给对应开发修复，并安排测试验收。",
    "完成后系统会把你的最终汇总和测试验收结论自动评论到该工单，请在汇总里写清改了什么、如何验证。",
  );
  return lines.join("\n");
}

export function buildWritebackComment({ status, summary = "", acceptance = null, taskId, project }) {
  const lines = [`**MultyAgent 处理结果：${STATUS_TEXT[status] || status}**`, "", `项目 \`${project}\` · 任务 \`${taskId}\``];
  if (summary) lines.push("", "### 项目经理汇总", clip(summary, 4000));
  if (acceptance) {
    lines.push("", `### 测试验收：${VERDICT_TEXT[acceptance.verdict] || acceptance.verdict}`);
    if (acceptance.summary) lines.push(acceptance.summary);
    for (const check of acceptance.checks || []) lines.push(`- ${check.status === "pass" ? "✅" : check.status === "fail" ? "❌" : "⏭️"} ${check.id ? `${check.id} ` : ""}${check.title}${check.detail ? `：${check.detail}` : ""}`);
    if (acceptance.skipReason) lines.push(`跳过原因：${acceptance.skipReason}`);
  } else if (status === "completed") {
    lines.push("", "_本轮没有测试验收记录。_");
  }
  return lines.join("\n");
}

export function buildTicketCard({ repo, ticket, ticketKey }) {
  const urgent = ticket.priority.rank === 0;
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: { template: urgent ? "red" : "orange", title: { tag: "plain_text", content: `新工单 · ${repo}#${ticket.number}` } },
    body: {
      elements: [
        { tag: "div", text: { tag: "lark_md", content: [`**${clip(ticket.title, 200)}**`, `优先级：${ticket.priority.label}${ticket.labels.length ? ` · 标签：${ticket.labels.slice(0, 6).join("、")}` : ""}`, clip(ticket.body, 400) || "（无描述）", ticket.url].join("\n\n") } },
        { tag: "action", actions: [
          { tag: "button", text: { tag: "plain_text", content: "交给项目经理" }, type: "primary", value: { action: "ticket", decision: "dispatch", ticket_key: ticketKey } },
          { tag: "button", text: { tag: "plain_text", content: "忽略" }, type: "default", value: { action: "ticket", decision: "ignore", ticket_key: ticketKey } },
        ] },
      ],
    },
  };
}

export function createTicketService({
  file = "runtime/tickets.json",
  client,
  submitTask,
  recordEvent = async () => {},
  sendCard = null,
  defaultChatId = "",
  workspaceRoot = process.cwd(),
  downloader = downloadImages,
  token = "",
  now = () => new Date(),
  log = console,
} = {}) {
  let state = null;
  let writing = Promise.resolve();
  let timer = null;
  const pulling = new Set();
  // 根任务 → 工单键；项目经理最近一次汇总与最近一次验收只在任务进行中用到，随记录一起落盘。
  const byTask = new Map();

  async function load() {
    if (state) return state;
    state = await readJsonFile(file, { fallback: () => ({}), onCorrupt: "backup", log }) || {};
    state.sources ||= [];
    state.dispatches ||= {};
    state.pending ||= {};
    for (const [key, record] of Object.entries(state.dispatches)) if (record.taskId) byTask.set(record.taskId, key);
    return state;
  }
  function persist() {
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    writing = writing.then(() => writeFileAtomic(file, snapshot)).catch((error) => log.error?.(`[tickets] persist failed: ${error.message}`));
    return writing;
  }
  function sourceById(id) {
    const source = state.sources.find((item) => item.id === id);
    if (!source) throw new Error("找不到这个工单源");
    return source;
  }
  function ticketStatus(key) {
    if (state.pending[key]) return { status: "awaiting_confirmation" };
    const record = state.dispatches[key];
    return record ? { status: record.status, taskId: record.taskId || null, closed: Boolean(record.closed) } : { status: "new" };
  }

  async function listSources({ project = "" } = {}) {
    await load();
    return state.sources.filter((source) => !project || source.project === project).map((source) => ({ ...source, pull: { ...source.pull } }));
  }

  async function saveSource(input = {}) {
    await load();
    const repo = assertRepo(input.repo);
    const project = clip(input.project, 64);
    if (!PROJECT_NAME.test(project)) throw new Error("请选择本地项目");
    const everyHours = Number(input.pull?.everyHours ?? 4);
    if (!Number.isInteger(everyHours) || everyHours < 1 || everyHours > 24) throw new Error("拉单间隔须为 1 到 24 小时");
    const threshold = String(input.pull?.threshold || "major");
    if (!PULL_THRESHOLDS.includes(threshold)) throw new Error("优先级门槛不正确");
    const existing = input.id ? sourceById(input.id) : null;
    if (state.sources.some((item) => item.repo.toLowerCase() === repo.toLowerCase() && item.id !== existing?.id)) throw new Error("这个仓库已经配置过工单源");
    const enabled = input.pull?.enabled === true;
    const source = {
      id: existing?.id || randomUUID().replaceAll("-", "").slice(0, 12),
      repo,
      project,
      labels: (Array.isArray(input.labels) ? input.labels : String(input.labels || "").split(",")).map((item) => clip(item, 50)).filter(Boolean).slice(0, 10),
      assignee: clip(input.assignee, 60),
      autoClose: input.autoClose === true,
      pull: {
        enabled,
        everyHours,
        threshold,
        confirmInFeishu: input.pull?.confirmInFeishu !== false,
        chatId: clip(input.pull?.chatId, 80),
        nextRunAt: enabled ? (existing?.pull?.enabled && existing.pull.everyHours === everyHours && existing.pull.nextRunAt) || new Date(now().getTime() + everyHours * HOUR_MS).toISOString() : null,
        lastRunAt: existing?.pull?.lastRunAt || null,
        lastResult: existing?.pull?.lastResult || "",
      },
    };
    state.sources = existing ? state.sources.map((item) => item.id === source.id ? source : item) : [...state.sources, source];
    await persist();
    return source;
  }

  async function removeSource(id) {
    await load();
    sourceById(id);
    state.sources = state.sources.filter((item) => item.id !== id);
    await persist();
    return { removed: true };
  }

  async function fetchTickets(source) {
    const tickets = await client.listOpenIssues(source.repo, { labels: source.labels, assignee: source.assignee });
    return tickets.sort(byPriority);
  }

  async function inbox({ sourceId } = {}) {
    await load();
    const source = sourceById(sourceId);
    const tickets = await fetchTickets(source);
    return { source, tickets: tickets.map((ticket) => ({ ...ticket, body: clip(ticket.body, 600), ...ticketStatus(keyOf(source.repo, ticket.number)) })) };
  }

  async function dispatch({ sourceId, number, note = "", origin = "desktop" } = {}) {
    await load();
    if (typeof submitTask !== "function") throw new Error("项目经理未启用，无法派发工单");
    const source = sourceById(sourceId);
    const key = keyOf(source.repo, number);
    const previous = state.dispatches[key];
    if (previous?.status === "dispatched") return { taskId: previous.taskId, duplicate: true };
    const ticket = await client.getIssue(source.repo, number);
    if (ticket.state !== "open") throw new Error(`工单 #${ticket.number} 已关闭`);
    const urls = extractImageUrls(ticket.body);
    const images = urls.length
      ? (await downloader({ urls, dir: join(workspaceRoot, "workspace", source.project, "artifacts", "tickets", String(ticket.number)), token }))
        .map((item) => item.path ? { ...item, path: `workspace/${source.project}/artifacts/tickets/${ticket.number}/${item.path.split(/[\\/]/).pop()}` } : item)
      : [];
    const attempt = (previous?.attempt || 0) + 1;
    const result = await submitTask({
      projectName: source.project,
      title: clip(`#${ticket.number} ${ticket.title}`, 240),
      description: buildTicketPrompt({ repo: source.repo, ticket, note, images }),
      idempotencyKey: `ticket:github:${key}${attempt > 1 ? `:${attempt}` : ""}`,
      messageId: `ticket-${source.repo}-${ticket.number}-${attempt}`.replace(/[^A-Za-z0-9-]/g, "-"),
    });
    state.dispatches[key] = { repo: source.repo, number: ticket.number, sourceId: source.id, project: source.project, title: ticket.title, url: ticket.url, status: "dispatched", taskId: result.taskId, attempt, origin, at: now().toISOString(), summary: "", acceptance: null, closed: false };
    delete state.pending[key];
    byTask.set(result.taskId, key);
    await persist();
    await recordEvent({ type: "ticket_dispatched", task_id: result.taskId, project_name: source.project, repo: source.repo, issue_number: ticket.number, issue_url: ticket.url, origin, image_count: images.filter((item) => item.path).length });
    return { taskId: result.taskId, duplicate: Boolean(result.duplicate) };
  }

  async function writeBack(key, status) {
    const record = state.dispatches[key];
    const source = state.sources.find((item) => item.id === record.sourceId);
    try {
      const comment = await client.comment(record.repo, record.number, buildWritebackComment({ status, summary: record.summary, acceptance: record.acceptance, taskId: record.taskId, project: record.project }));
      const verdict = record.acceptance?.verdict;
      const shouldClose = source?.autoClose === true && status === "completed" && (!verdict || verdict === "pass");
      if (shouldClose) await client.close(record.repo, record.number);
      record.closed = record.closed || shouldClose;
      record.commentUrl = comment.url;
      await persist();
      await recordEvent({ type: "ticket_written_back", task_id: record.taskId, project_name: record.project, repo: record.repo, issue_number: record.number, status, closed: shouldClose, comment_url: comment.url });
    } catch (error) {
      await recordEvent({ type: "ticket_writeback_failed", task_id: record.taskId, project_name: record.project, repo: record.repo, issue_number: record.number, status, error: clip(error.message, 300) });
    }
  }

  // 事件钩子：记录项目经理汇总与验收结论；根任务结束（结算/失败/终止）时回写工单。
  async function handleEvent(event = {}) {
    await load();
    const root = rootOf(event.task_id);
    const key = byTask.get(root);
    if (!key) return;
    const record = state.dispatches[key];
    if (event.type === "delivery_received" && event.agent === "project_manager" && event.summary) {
      record.summary = clip(event.summary, 4000);
      return persist();
    }
    if (event.type === "acceptance_submitted") {
      record.acceptance = { verdict: event.verdict, summary: event.summary || "", checks: event.checks || [], skipReason: event.skip_reason || "" };
      return persist();
    }
    if (event.task_id !== root) return;
    const status = event.type === "task_settle" ? "completed"
      : event.type === "task_failed" ? "failed"
        : ["task_terminated", "task_cancelled"].includes(event.type) ? "cancelled" : null;
    if (!status || record.status === status) return;
    record.status = status;
    await persist();
    await writeBack(key, status);
  }

  async function pull(sourceId, { reason = "manual" } = {}) {
    await load();
    const source = sourceById(sourceId);
    if (pulling.has(source.id)) throw new Error("这个工单源正在拉单");
    pulling.add(source.id);
    try {
      const tickets = await fetchTickets(source);
      const candidates = tickets.filter((ticket) => {
        const key = keyOf(source.repo, ticket.number);
        return !state.dispatches[key] && !state.pending[key] && matchesThreshold(ticket.priority, source.pull.threshold);
      }).slice(0, MAX_PER_PULL);
      const chatId = source.pull.chatId || defaultChatId;
      const confirm = source.pull.confirmInFeishu && typeof sendCard === "function" && Boolean(chatId);
      const failures = [];
      let handled = 0;
      for (const ticket of candidates) {
        const key = keyOf(source.repo, ticket.number);
        try {
          if (confirm) {
            await sendCard(chatId, buildTicketCard({ repo: source.repo, ticket, ticketKey: key }));
            state.pending[key] = { sourceId: source.id, number: ticket.number, title: ticket.title, chatId, at: now().toISOString() };
          } else {
            await dispatch({ sourceId: source.id, number: ticket.number, origin: "schedule" });
          }
          handled += 1;
        } catch (error) {
          failures.push(`#${ticket.number}：${clip(error.message, 120)}`);
        }
      }
      const summary = `拉到 ${tickets.length} 张，符合门槛 ${candidates.length} 张，${confirm ? "已推送飞书确认" : "已交给项目经理"} ${handled} 张${failures.length ? `；失败：${failures.join("；")}` : ""}`;
      source.pull.lastRunAt = now().toISOString();
      source.pull.lastResult = summary;
      await persist();
      await recordEvent({ type: "ticket_pull_finished", project_name: source.project, repo: source.repo, reason, fetched: tickets.length, handled, confirm, failed: failures.length });
      return { summary, handled, fetched: tickets.length };
    } catch (error) {
      source.pull.lastRunAt = now().toISOString();
      source.pull.lastResult = `拉单失败：${clip(error.message, 200)}`;
      await persist();
      throw error;
    } finally {
      pulling.delete(source.id);
    }
  }

  async function tick() {
    await load();
    const current = now();
    for (const source of state.sources) {
      if (!source.pull.enabled || !source.pull.nextRunAt || new Date(source.pull.nextRunAt) > current) continue;
      source.pull.nextRunAt = new Date(current.getTime() + source.pull.everyHours * HOUR_MS).toISOString();
      await persist();
      try { await pull(source.id, { reason: "schedule" }); }
      catch (error) { log.warn?.(`[tickets] scheduled pull ${source.repo} failed: ${error.message}`); }
    }
  }

  // 飞书确认卡回调：交给项目经理或忽略（忽略的工单不会再被定时拉单推送）。
  async function handleCardAction({ decision, ticket_key: ticketKey } = {}) {
    await load();
    const pending = state.pending[ticketKey];
    if (!pending) {
      const record = state.dispatches[ticketKey];
      return { ok: false, message: record ? "这张工单已经处理过了" : "确认已失效" };
    }
    if (decision === "ignore") {
      delete state.pending[ticketKey];
      const source = state.sources.find((item) => item.id === pending.sourceId);
      state.dispatches[ticketKey] = { repo: source?.repo || ticketKey.split("#")[0], number: pending.number, sourceId: pending.sourceId, project: source?.project || "", title: pending.title, status: "ignored", at: now().toISOString() };
      await persist();
      return { ok: true, message: `已忽略 #${pending.number}` };
    }
    const result = await dispatch({ sourceId: pending.sourceId, number: pending.number, origin: "feishu" });
    return { ok: true, message: `已交给项目经理（任务 ${result.taskId}）` };
  }

  return {
    listSources, saveSource, removeSource, inbox, dispatch, pull, tick, handleEvent, handleCardAction,
    hasToken: () => client?.hasToken?.() !== false,
    start(intervalMs = 60_000) {
      if (timer) return;
      timer = setInterval(() => { tick().catch((error) => log.warn?.(`[tickets] tick failed: ${error.message}`)); }, intervalMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    whenIdle: () => writing,
  };
}
