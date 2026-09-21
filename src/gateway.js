import { createTask, findRecentTask, findTaskByRoot, linkRootAlias, setPaused, updateTask } from "./tasks.js";
import { buildValidatedHandoff } from "./domain/delivery.js";
import { assertAudit } from "./domain/audit.js";

const TTL = Number(process.env.PI_CONVERSATION_TTL_MS) || 30 * 60 * 1000;
const NEW_TASK = /^\s*(?:\u65b0\u4efb\u52a1|\u65b0\u9700\u6c42|\u5f00\u59cb\u65b0\u4efb\u52a1|new task)\s*[:：]?\s*/i;
const PAUSE = /^\s*(?:\u6682\u505c|\u505c\u6b62|\u4e2d\u65ad|pause|stop)\s*[.!?。！？]?\s*$/i;
const RESUME = /^\s*(?:\u6062\u590d|\u7ee7\u7eed\u6267\u884c|resume)\s*[.!?。！？]?\s*$/i;
const APPROVE = /^\s*(?:\u786e\u8ba4\u6267\u884c|\u786e\u8ba4|\u6279\u51c6|\u540c\u610f\u6267\u884c|approve|approved|yes)\s*[.!?。！？]?\s*$/i;

// 人工确认门禁覆盖的角色。默认方案 A：六个角色各自确认一次。
// 回退到方案 B（仅汇总点确认）只需设置 PI_CONFIRM_ROLES=project_manager。
export const DEFAULT_CONFIRM_ROLES = "project_manager,architect,frontend_developer,backend_developer,tester,auditor";
export function parseConfirmRoles(raw = process.env.PI_CONFIRM_ROLES) {
  const value = raw === undefined || raw === null || String(raw).trim() === "" ? DEFAULT_CONFIRM_ROLES : String(raw);
  return new Set(value.split(",").map((key) => key.trim()).filter(Boolean));
}

export function parseMessage(event) {
  const message = event?.message || event?.event?.message;
  if (!message?.message_id || !message.chat_id) return null;
  let parsed;
  try { parsed = JSON.parse(message.content ?? "{}"); } catch { return null; }
  if (typeof parsed.text !== "string") return null;
  return { messageId: message.message_id, chatId: message.chat_id, rootId: message.root_id || message.parent_id || message.thread_id || null, text: parsed.text.replace(/<at\b[^>]*>.*?<\/at>/gi, "").trim() };
}

export function parseNewTaskCommand(text) {
  const raw = String(text || "");
  const match = raw.match(NEW_TASK);
  return match ? { isNewTask: true, text: raw.slice(match[0].length).trim() } : { isNewTask: false, text: raw.trim() };
}
export function parseControlCommand(text) { const value = String(text || "").trim(); return PAUSE.test(value) ? "pause" : RESUME.test(value) ? "resume" : null; }
export function isApprovalCommand(text) { return APPROVE.test(String(text || "").trim()); }

export function createDeduper(limit = 10_000) {
  const seen = new Set();
  const accept = (id) => { if (seen.has(id)) return false; seen.add(id); if (seen.size > limit) seen.delete(seen.values().next().value); return true; };
  accept.release = (id) => seen.delete(id);
  return accept;
}

function clip(value, max = 1000) { const text = String(value || "").trim(); return text.length > max ? `${text.slice(0, max)}…` : text; }
function cardText(value, max = 1000) { return clip(String(value || "").replace(/[<>]/g, ""), max); }
function cleanText(value) { return String(value || "").replace(/^#{1,6}\s*/gm, "").replace(/\*\*/g, "").replace(/^\s*[-*]\s+/gm, "· ").replace(/\n{3,}/g, "\n\n").trim(); }
function shortId(id) { return String(id || "").slice(0, 8); }

export async function sendText(client, chatId, text) { return client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: "text" } }); }
export async function sendCard(client, chatId, card) {
  const hasAction = card?.body?.elements?.some((element) => element?.tag === "action");
  const payload = hasAction
    ? { config: card.config, header: card.header, elements: card.body.elements }
    : card;
  return client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, content: JSON.stringify(payload), msg_type: "interactive" } });
}

export function buildTextCard(result = {}, agent = {}) {
  const responder = agent.displayName || agent.name || agent.key || "机器人";
  return { schema: "2.0", config: { wide_screen_mode: true }, header: { template: "blue", title: { tag: "plain_text", content: `${responder} 回复` } }, body: { elements: [{ tag: "div", text: { tag: "lark_md", content: cardText(result.text || "（无回复内容）", 1800) } }] } };
}
export function buildTaskReceivedCard(agent = {}, taskId, taskText = "") {
  const content = ["已接收任务", taskText ? cardText(taskText, 600) : ""].filter(Boolean).join("\n\n");
  const responder = agent.displayName || agent.name || agent.key || "机器人";
  return { schema: "2.0", config: { wide_screen_mode: true }, header: { template: "blue", title: { tag: "plain_text", content: `${responder} · 任务接收` } }, body: { elements: [{ tag: "div", text: { tag: "lark_md", content } }] } };
}

function normalizeDelivery(value) {
  const source = value && typeof value === "object" ? value : {};
  const list = (items) => Array.isArray(items) ? items.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : [];
  return { agentKey: String(source.agentKey || "").trim(), agentName: String(source.agentName || "").trim(), summary: String(source.summary || "").trim(), artifactPaths: list(source.artifactPaths), next: String(source.next || "").trim(), assumptions: list(source.assumptions), assignments: Array.isArray(source.assignments) ? source.assignments.filter((item) => item?.agentKey && item?.task).map((item) => ({ agentKey: String(item.agentKey).trim(), task: String(item.task).trim(), reason: String(item.reason || "").trim() })) : [], choices: Array.isArray(source.choices) ? source.choices.filter((item) => item?.id && item?.label).slice(0, 6) : [], final: source.final === true };
}

export function buildResultCard(result = {}) {
  const delivery = normalizeDelivery(result.delivery);
  const final = delivery.final;
  const confirmRoles = parseConfirmRoles();
  const approvalRequired = result.approvalRequired === true || (!final && Boolean(delivery.agentKey) && confirmRoles.has(delivery.agentKey));
  const choices = delivery.choices.length ? delivery.choices : approvalRequired ? [{ id: "approve", label: "确认执行", primary: true }] : [];
  const lines = [delivery.summary ? `**结果**\n${cardText(delivery.summary)}` : "", approvalRequired && delivery.assignments.length ? `**任务分配**\n${delivery.assignments.slice(0, 6).map((item) => `· ${cardText(item.task, 240)}`).join("\n")}` : "", delivery.artifactPaths.length ? `**产物（${delivery.artifactPaths.length} 项）**\n${delivery.artifactPaths.slice(0, 5).map((path) => `· \`${cardText(path, 240)}\``).join("\n")}` : "", delivery.next ? `**下一步**\n${cardText(delivery.next, 400)}` : "", delivery.assumptions.length ? `**需要关注**\n${delivery.assumptions.slice(0, 3).map((item) => `· ${cardText(item, 240)}`).join("\n")}` : ""].filter(Boolean);
  const content = cardText(`${lines.join("\n\n") || "任务已完成。"}${approvalRequired ? "\n\n请确认后继续执行。" : ""}`, 1200);
  const elements = [{ tag: "div", text: { tag: "lark_md", content } }];
  if (choices.length) elements.push({ tag: "action", actions: choices.map((choice) => ({ tag: "button", text: { tag: "plain_text", content: String(choice.label) }, type: choice.primary ? "primary" : "default", value: { action: choice.id === "approve" ? "approve" : "choice", choice: String(choice.id), label: String(choice.label) } })) });
  const title = final ? "最终交付" : approvalRequired ? "请确认下一步" : "阶段完成";
  return { schema: "2.0", config: { wide_screen_mode: true }, header: { template: final ? "green" : "blue", title: { tag: "plain_text", content: `${title}${delivery.agentName ? ` · ${delivery.agentName}` : ""}` } }, body: { elements } };
}

export function buildFailureCard(agent = {}, error) { return { schema: "2.0", config: { wide_screen_mode: true }, header: { template: "red", title: { tag: "plain_text", content: `任务失败${agent.displayName ? ` · ${agent.displayName}` : ""}` } }, body: { elements: [{ tag: "div", text: { tag: "lark_md", content: `**错误**\n${cardText(error?.message || error, 800)}` } }] } }; }
export function buildReply(result, maxLen = 400) { const delivery = result?.delivery; if (!delivery) return clip(cleanText(result?.text || ""), maxLen) || "（无回复内容）"; const parts = [`${delivery.final ? "最终交付" : "交付完成"} · ${delivery.agentName || delivery.agentKey || ""}`]; if (delivery.summary) parts.push("", "结果", clip(delivery.summary, maxLen)); if (delivery.artifactPaths?.length) parts.push("", `产物（${delivery.artifactPaths.length} 项）`, ...delivery.artifactPaths.slice(0, 8).map((path) => `· ${path}`)); if (delivery.next) parts.push("", "下一步", clip(delivery.next, 200)); if (delivery.assumptions?.length) parts.push("", "待确认", ...delivery.assumptions.slice(0, 5).map((item) => `· ${clip(item, 120)}`)); return parts.join("\n"); }

const ACTION_SUCCESS_TOAST = "已确认，正在继续执行";
const ACTION_NO_PENDING_TOAST = "当前没有等待确认的任务";
const ACTION_INVALID_TOAST = "该操作无需确认或已失效";
const ACTION_ERROR_TOAST = "确认失败，请查看网关日志";
function toast(type, content) { return { toast: { type, content } }; }

export function createCardActionHandler({ orchestrator, client, agent = {}, log = console } = {}) {
  return async (event) => {
    const rawValue = event?.action?.value ?? event?.event?.action?.value;
    let value = rawValue;
    if (typeof rawValue === "string") {
      try { value = JSON.parse(rawValue); } catch { value = {}; }
    }
    if (!value || typeof value !== "object") value = {};
    const action = value.action || value.type;
    const chatId = event?.chatId || event?.event?.chatId || event?.context?.open_chat_id || event?.event?.context?.open_chat_id || event?.open_chat_id;
    if (!["approve", "choice"].includes(action) || !chatId || !orchestrator?.resolveLatest) return toast("warning", ACTION_INVALID_TOAST);
    try {
      const resolved = await orchestrator.resolveLatest(chatId, value.choice || "approve");
      await sendCard(client, chatId, buildTextCard({ text: resolved ? "已确认，正在继续执行。" : "当前没有等待选择的任务。" }, resolved ? { displayName: resolved.agentName } : agent));
      return resolved ? toast("success", ACTION_SUCCESS_TOAST) : toast("warning", ACTION_NO_PENDING_TOAST);
    } catch (error) {
      log.error(`card action failed: ${error.message}`);
      return toast("error", ACTION_ERROR_TOAST);
    }
  };
}

export function createRoleHandler({ agent, client, runAgent, isAllowedChat = () => true, log = console, orchestrator, taskStore }) {
  const accept = createDeduper();
  return async (event) => {
    const message = parseMessage(event);
    if (!message || !accept(message.messageId) || !isAllowedChat(message.chatId)) return;
    if (isApprovalCommand(message.text) && orchestrator?.approveLatest) { const approved = await orchestrator.approveLatest(message.chatId); await sendCard(client, message.chatId, buildTextCard({ text: approved ? "已确认，正在继续执行。" : "当前没有等待确认的任务。" }, agent)); return; }
    const { isNewTask, text } = parseNewTaskCommand(message.text);
    let task = null;
    if (!isNewTask) task = (message.rootId && await findTaskByRoot(agent.key, message.rootId)) || (!message.rootId && await findRecentTask(agent.key, message.chatId, TTL));
    if (!task) task = await createTask({ agentKey: agent.key, chatId: message.chatId, rootKey: message.rootId || message.messageId, messageId: message.messageId });
    else await updateTask(task.taskId, { lastMessageId: message.messageId });
    const control = parseControlCommand(text);
    if (control) { await setPaused(task.taskId, control === "pause"); await sendCard(client, message.chatId, buildTextCard({ text: control === "pause" ? "任务已暂停。" : "任务已恢复。" }, agent)); return; }
    await sendCard(client, message.chatId, buildTaskReceivedCard(agent, task.taskId, text));
    try {
      const result = await runAgent(agent, text, { taskId: task.taskId, chatId: message.chatId, appId: agent.appId });
      if (result.delivery) { await buildValidatedHandoff(result.delivery, { agentKey: agent.key, taskId: task.taskId }); await sendCard(client, message.chatId, buildResultCard(result)); if (orchestrator) await orchestrator.onTaskCompleted(agent.key, task.taskId, { delivery: result.delivery, context: { chatId: message.chatId, requireHumanApproval: true } }); }
      else await sendCard(client, message.chatId, buildTextCard(result, agent));
    } catch (error) {
      log.error(`[${agent.key}] task failed: ${error.message}`);
      await sendCard(client, message.chatId, buildFailureCard(agent, error));
    }
  };
}
