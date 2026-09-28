import { createTask, findRecentTask, findTaskByRoot, linkRootAlias, setPaused, isTerminated, updateTask } from "./tasks.js";
import { buildValidatedHandoff } from "./domain/delivery.js";
import { assertAudit } from "./domain/audit.js";
import { loadTaskStatus } from "./task-status.js";

const TTL = Number(process.env.PI_CONVERSATION_TTL_MS) || 30 * 60 * 1000;
const STATUS_QUERY = /^\s*(?:(?:\u67e5\u8be2|\u67e5\u770b|\u544a\u8bc9\u6211|\u6c47\u62a5)?\s*(?:\u5f53\u524d|\u8fd9\u4e2a|\u8be5|\u672c)?\s*(?:\u4efb\u52a1|\u9879\u76ee)?\s*(?:\u72b6\u6001|\u8fdb\u5ea6|\u8fdb\u5c55)|\u73b0\u5728(?:\u5230\u54ea\u4e86|\u8fdb\u5c55\u5982\u4f55|\u4ec0\u4e48\u72b6\u6001)|status|progress)\s*[.!?\u3002\uff01\uff1f\uff1b;\s]*$/i;
const STATUS_QUERY_FOLLOWUP = /^\s*(?:\u67e5\u4e00\u4e0b|\u67e5\u770b\u4e00\u4e0b|\u4efb\u52a1|\u9879\u76ee)\s*(?:\u73b0\u5728)?\s*(?:\u72b6\u6001|\u8fdb\u5ea6|\u8fdb\u5c55)(?:\u600e\u4e48\u6837|\u5982\u4f55|\u600e\u6837|\u5462)?\s*[.!?\u3002\uff01\uff1f;\s]*$/i;
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
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    rootId: message.root_id || message.parent_id || message.thread_id || null,
    text: parsed.text.replace(/<at\b[^>]*>.*?<\/at>/gi, "").trim(),
    chatType: message.chat_type || null,
    // 飞书会把「用户/机器人」发的消息都推过来，用 sender_type 区分：user / app。
    senderType: String((event?.sender || event?.event?.sender)?.sender_type || "").toLowerCase(),
    mentions: Array.isArray(message.mentions)
      ? message.mentions.map((item) => ({ openId: item?.id?.open_id || null, name: item?.name || "" }))
      : [],
  };
}

// 群聊路由：@ 了哪个机器人就只给哪个机器人；没人被 @ 时默认交给项目经理。
// 单聊里机器人本来就是对话对象，照旧全部处理。
// selfName 用飞书里的真实应用名（bot/v3/info 的 app_name），@ 消息里的 name 就是这个值。
export function shouldHandleMessage(message, { agentKey, displayName = "", selfName = "", selfOpenId = null, botNames = [] } = {}) {
  if (!message) return false;
  if ((message.chatType || "p2p") !== "group") return true;
  const selfNames = new Set([selfName, displayName].filter(Boolean));
  const allNames = new Set([...botNames, ...selfNames]);
  const isSelf = (item) => Boolean((selfOpenId && item.openId === selfOpenId) || (item.name && selfNames.has(item.name)));
  const isBot = (item) => isSelf(item) || Boolean(item.name && allNames.has(item.name));
  const botMentions = (message.mentions || []).filter(isBot);
  if (botMentions.length) return botMentions.some(isSelf);
  return agentKey === "project_manager";
}

export function parseNewTaskCommand(text) {
  const raw = String(text || "");
  const match = raw.match(NEW_TASK);
  return match ? { isNewTask: true, text: raw.slice(match[0].length).trim() } : { isNewTask: false, text: raw.trim() };
}
export function parseControlCommand(text) { const value = String(text || "").trim(); return PAUSE.test(value) ? "pause" : RESUME.test(value) ? "resume" : null; }
export function isApprovalCommand(text) { return APPROVE.test(String(text || "").trim()); }
export function isStatusQueryCommand(text) { const value = String(text || "").trim(); return STATUS_QUERY.test(value) || STATUS_QUERY_FOLLOWUP.test(value); }

export function createDeduper(limit = 10_000) {
  const seen = new Set();
  const accept = (id) => { if (seen.has(id)) return false; seen.add(id); if (seen.size > limit) seen.delete(seen.values().next().value); return true; };
  accept.release = (id) => seen.delete(id);
  return accept;
}

function clip(value, max = 1000) { const text = String(value || "").trim(); return text.length > max ? `${text.slice(0, max)}…` : text; }
// 卡片正文按「普通文本」呈现：只保留标题加粗，其余 Markdown 记号一律清掉。
// 飞书的 lark_md 不认标题、反引号、表格，原样塞进去会看到「## 结论」「| a | b |」这种噪声。
function cardText(value, max = 1000) {
  const text = String(value || "")
    // 引用符号先处理：下面的尖括号清理会把 ">" 吃掉，留下一个孤零零的行首空格。
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/[<>]/g, "")
    .replace(/^```[a-zA-Z0-9_-]*\s*$/gm, "")
    .replace(/^#{1,6}\s*(.+?)\s*$/gm, "**$1**")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*\r?\n/gm, "")
    .replace(/^[ \t]*\|(.+?)\|[ \t]*$/gm, (_, row) => row.split("|").map((cell) => cell.trim()).filter(Boolean).join(" · "))
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/(^|\s)\*([^\s*][^*\n]*?[^\s*])\*(?=[\s，。；：、！？）】.]|$)/g, "$1$2")
    .replace(/^\s*[-*]\s+/gm, "· ")
    .replace(/\n{3,}/g, "\n\n");
  return clip(text, max);
}
function cleanText(value) { return String(value || "").replace(/^#{1,6}\s*/gm, "").replace(/\*\*/g, "").replace(/^\s*[-*]\s+/gm, "· ").replace(/\n{3,}/g, "\n\n").trim(); }
function shortId(id) { return String(id || "").slice(0, 8); }

export async function sendText(client, chatId, text) { return client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: "text" } }); }
// 卡片里嵌图必须先上传拿 image_key；需要应用开通 im:resource:upload 权限。
export async function uploadCardImage(client, image, { imageType = "message" } = {}) {
  const response = await client.im.image.create({ data: { image_type: imageType, image } });
  return response?.data?.image_key || response?.image_key || null;
}
export async function sendCard(client, chatId, card) {
  const hasAction = card?.body?.elements?.some((element) => element?.tag === "action");
  const payload = hasAction
    ? { config: card.config, header: card.header, elements: card.body.elements }
    : card;
  return client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, content: JSON.stringify(payload), msg_type: "interactive" } });
}

// 交付卡片：交付包里带 diagram 时，先渲染成 PNG 再上传，把图片嵌进卡片。
// 渲染或上传任一步失败都降级为纯文本卡片，不影响交付本身。
// 只有架构类角色该在卡片里附架构图，其余角色即使填了也不渲染，避免职责串味。
function diagramRoles() {
  return new Set(String(process.env.PI_DIAGRAM_ROLES || "architect").split(",").map((item) => item.trim()).filter(Boolean));
}

export async function sendResultCard(client, chatId, result, { log = console, taskId = null } = {}) {
  let diagramImageKey = null;
  const agentKey = result?.delivery?.agentKey || null;
  const allowed = diagramRoles();
  if (result?.delivery?.diagram && agentKey && !allowed.has(agentKey)) {
    log.info?.(`[diagram] skipped for ${agentKey}（仅 ${[...allowed].join(", ")} 可附架构图）`);
  } else if (result?.delivery?.diagram) {
    try {
      const { renderDiagramPng } = await import("./diagram.js");
      const png = renderDiagramPng(result.delivery.diagram);
      if (png) diagramImageKey = await uploadCardImage(client, png);
    } catch (error) {
      log.error?.(`diagram embed failed: ${error.message}`);
    }
  }
  return sendCard(client, chatId, buildResultCard({ ...result, ...(taskId ? { taskId } : {}), diagramImageKey }));
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
  return { agentKey: String(source.agentKey || "").trim(), agentName: String(source.agentName || "").trim(), summary: String(source.summary || "").trim(), artifactPaths: list(source.artifactPaths), next: String(source.next || "").trim(), blockers: list(source.blockers), assumptions: list(source.assumptions), risks: list(source.risks), evidence: Array.isArray(source.evidence) ? source.evidence.filter((item) => item?.command && item?.result).slice(0, 6).map((item) => ({ command: String(item.command).trim(), result: String(item.result).trim(), details: String(item.details || "").trim() })) : [], commit: String(source.commit || source.commitHash || "").trim(), durationMs: Number.isFinite(Number(source.durationMs)) ? Number(source.durationMs) : null, assignments: Array.isArray(source.assignments) ? source.assignments.filter((item) => item?.agentKey && item?.task).map((item) => ({ agentKey: String(item.agentKey).trim(), task: String(item.task).trim(), reason: String(item.reason || "").trim() })) : [], choices: Array.isArray(source.choices) ? source.choices.filter((item) => item?.id && item?.label).slice(0, 6) : [], final: source.final === true };
}

export function hasActionableNextStep(delivery = {}) {
  return Boolean(
    String(delivery.next || "").trim()
      || (Array.isArray(delivery.assignments) && delivery.assignments.length)
      || (Array.isArray(delivery.choices) && delivery.choices.length),
  );
}

export function buildResultCard(result = {}) {
  const delivery = normalizeDelivery(result.delivery);
  if (!delivery.summary && result.text) delivery.summary = cleanText(result.text).trim();
  const final = delivery.final;
  const confirmRoles = parseConfirmRoles();
  const approvalRequired = result.approvalRequired === true || (!final && hasActionableNextStep(delivery) && Boolean(delivery.agentKey) && confirmRoles.has(delivery.agentKey));
  const explicitApproval = result.approvalRequired === true;
  const choices = (delivery.choices.length && (!final || explicitApproval)) ? delivery.choices : (approvalRequired && (!final || explicitApproval)) ? [{ id: "approve", label: "确认执行", primary: true }] : [];
  const evidenceText = delivery.evidence.length ? `**验证证据**\n${delivery.evidence.map((item) => `· ${cardText(item.command, 180)} → ${cardText(item.result, 120)}${item.details ? `（${cardText(item.details, 240)}）` : ""}`).join("\n")}` : "";
  const executionText = [delivery.commit ? `Commit ${cardText(delivery.commit, 80)}` : "", delivery.durationMs === null ? "" : `耗时 ${(delivery.durationMs / 1000).toFixed(1)} 秒`].filter(Boolean).join(" · ");
  const nextText = delivery.next ? `**下一步**\n${cardText(delivery.next, 400)}` : "";
  const lines = [approvalRequired ? nextText : "", delivery.summary ? `**结果**\n${cardText(delivery.summary)}` : "", delivery.artifactPaths.length ? `**产物（${delivery.artifactPaths.length} 项）**\n${delivery.artifactPaths.slice(0, 5).map((path) => `· \`${cardText(path, 240)}\``).join("\n")}` : "", evidenceText, executionText ? `**执行信息**\n${executionText}` : "", approvalRequired && delivery.assignments.length ? `**任务分配**\n${delivery.assignments.slice(0, 6).map((item) => `· ${cardText(item.task, 240)}`).join("\n")}` : "", !approvalRequired ? nextText : "", delivery.blockers.length ? `**阻塞**\n${delivery.blockers.slice(0, 3).map((item) => `· ${cardText(item, 240)}`).join("\n")}` : "", delivery.risks.length ? `**风险**\n${delivery.risks.slice(0, 3).map((item) => `· ${cardText(item, 240)}`).join("\n")}` : "", delivery.assumptions.length ? `**需要关注**\n${delivery.assumptions.slice(0, 3).map((item) => `· ${cardText(item, 240)}`).join("\n")}` : ""].filter(Boolean);
  const content = cardText(`${lines.join("\n\n") || "任务已完成。"}${approvalRequired ? "\n\n请确认后继续执行。" : ""}`, 1200);
  const elements = [{ tag: "div", text: { tag: "lark_md", content } }];
  if (result.diagramImageKey) {
    elements.push({ tag: "img", img_key: String(result.diagramImageKey), alt: { tag: "plain_text", content: result.diagramAlt || "系统架构流程图" } });
  }
  if (choices.length) elements.push({ tag: "action", actions: choices.map((choice) => ({ tag: "button", text: { tag: "plain_text", content: String(choice.label) }, type: choice.primary ? "primary" : "default", value: { action: choice.id === "approve" ? "approve" : "choice", choice: String(choice.id), label: String(choice.label), ...(result.taskId ? { task_id: String(result.taskId) } : {}) } })) });
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

export function createCardActionHandler({ orchestrator, client, agent = {}, log = console, onEvent = async () => {} } = {}) {
  return async (event) => {
    const rawValue = event?.action?.value ?? event?.event?.action?.value;
    let value = rawValue;
    if (typeof rawValue === "string") {
      try { value = JSON.parse(rawValue); } catch { value = {}; }
    }
    if (!value || typeof value !== "object") value = {};
    const action = value.action || value.type;
    const chatId = event?.chatId || event?.event?.chatId || event?.context?.open_chat_id || event?.event?.context?.open_chat_id || event?.open_chat_id;
    await onEvent({ type: "card_action_received", action: action || null, choice: value.choice || null, chat_id: chatId || null, agent: agent.key, message_id: event?.messageId || null });
    // 回调诊断：多实例或事件投递异常时，这两行日志能直接说明点击落到了哪个进程/会话。
    log.info?.(`[card] pid=${process.pid} action=${action || "-"} choice=${value.choice || "-"} chat=${chatId || "-"} message=${event?.messageId || "-"}`);
    if (!["approve", "choice"].includes(action) || !chatId || !orchestrator?.resolveLatest) return toast("warning", ACTION_INVALID_TOAST);
    try {
      const resolved = await orchestrator.resolveLatest(chatId, value.choice || "approve", value.task_id || null);
      await onEvent({ type: "card_action_resolved", action, choice: value.choice || "approve", chat_id: chatId, agent: agent.key, resolved: Boolean(resolved), resolved_agent: resolved?.agentKey || null, task_id: resolved?.taskId || null });
      log.info?.(`[card] pid=${process.pid} resolved=${Boolean(resolved)} agent=${resolved?.agentKey || "-"}`);
      await sendCard(client, chatId, buildTextCard({ text: resolved ? "已确认，正在继续执行。" : "当前没有等待选择的任务。" }, resolved ? { displayName: resolved.agentName } : agent));
      return resolved ? toast("success", ACTION_SUCCESS_TOAST) : toast("warning", ACTION_NO_PENDING_TOAST);
    } catch (error) {
      log.error(`card action failed: ${error.message}`);
      return toast("error", ACTION_ERROR_TOAST);
    }
  };
}

export function createRoleHandler({ agent, client, runAgent, isAllowedChat = () => true, log = console, onEvent = async () => {}, orchestrator, taskStore, getTaskStatus = (taskId, chatId) => taskStore?.getStatus?.(taskId, chatId) || loadTaskStatus(taskId, chatId), botNames = [], selfOpenId = null, selfName = "" }) {
  const accept = createDeduper();
  return async (event) => {
    const message = parseMessage(event);
    if (!message) return;
    await onEvent({ type: "message_received", agent: agent.key, message_id: message.messageId, chat_id: message.chatId, root_id: message.rootId, chat_type: message.chatType, sender_type: message.senderType, mentions: message.mentions.map((item) => item.name || item.openId).filter(Boolean) });
    // 到达日志：飞书是否把这条消息投给了这个机器人，一眼可见，用于核对群消息权限。
    log.info?.(`[msg] pid=${process.pid} ${agent.key} chat=${message.chatId} type=${message.chatType || "-"} sender=${message.senderType || "-"} mentions=${(message.mentions || []).map((item) => item.name || item.openId).join("|") || "-"}`);
    // 只吃用户发的消息。机器人之间（含本网关自己发的卡片）不能被当成新输入，否则会自激循环。
    if (message.senderType && message.senderType !== "user") { await onEvent({ type: "message_ignored", reason: "sender_not_user", agent: agent.key, message_id: message.messageId, chat_id: message.chatId }); return; }
    if (!isAllowedChat(message.chatId)) { await onEvent({ type: "message_ignored", reason: "chat_not_allowed", agent: agent.key, message_id: message.messageId, chat_id: message.chatId }); return; }
    if (!shouldHandleMessage(message, { agentKey: agent.key, displayName: agent.displayName, selfName, selfOpenId, botNames })) { await onEvent({ type: "message_ignored", reason: "routing", agent: agent.key, message_id: message.messageId, chat_id: message.chatId }); return; }
    if (!accept(message.messageId)) { await onEvent({ type: "message_ignored", reason: "duplicate", agent: agent.key, message_id: message.messageId, chat_id: message.chatId }); return; }
    if (isApprovalCommand(message.text) && orchestrator?.approveLatest) { const approved = await orchestrator.approveLatest(message.chatId); await sendCard(client, message.chatId, buildTextCard({ text: approved ? "已确认，正在继续执行。" : "当前没有等待确认的任务。" }, agent)); return; }
    const { isNewTask, text } = parseNewTaskCommand(message.text);
    if (!isNewTask && isStatusQueryCommand(text)) {
      const task = (message.rootId && await findTaskByRoot(agent.key, message.rootId))
        || (!message.rootId && await findRecentTask(agent.key, message.chatId, null));
      if (!task) {
        await sendCard(client, message.chatId, buildTextCard({ text: "当前群聊没有可查询的任务。" }, agent));
        return;
      }
      try {
        const status = await getTaskStatus(task.taskId, message.chatId);
        const summary = [
          `任务 ${task.taskId}`,
          `状态：${status?.status || "not_found"}`,
          status?.active_agents?.length ? `执行中：${status.active_agents.join("、")}` : "执行中：无",
          status?.latest_event ? `最近事件：${status.latest_event}` : "",
          status?.error ? `错误：${status.error}` : "",
        ].filter(Boolean).join("\n");
        await sendCard(client, message.chatId, buildTextCard({ text: summary }, agent));
      } catch (error) {
        await onEvent({ type: "task_status_query_failed", task_id: task.taskId, agent: agent.key, chat_id: message.chatId, error: error.message });
        log.error(`[${agent.key}] task status query failed: ${error.message}`);
        await sendCard(client, message.chatId, buildFailureCard(agent, error));
      }
      return;
    }
    let task = null;
    if (!isNewTask) task = (message.rootId && await findTaskByRoot(agent.key, message.rootId)) || (!message.rootId && await findRecentTask(agent.key, message.chatId, TTL));
    if (!task) { task = await createTask({ agentKey: agent.key, chatId: message.chatId, rootKey: message.rootId || message.messageId, messageId: message.messageId }); await onEvent({ type: "task_created", task_id: task.taskId, agent: agent.key, chat_id: message.chatId, message_id: message.messageId, text: text.slice(0, 200) }); }
    else { await updateTask(task.taskId, { lastMessageId: message.messageId }); await onEvent({ type: "task_reused", task_id: task.taskId, agent: agent.key, chat_id: message.chatId, message_id: message.messageId, text: text.slice(0, 200) }); }
    const control = parseControlCommand(text);
    if (control) { await setPaused(task.taskId, control === "pause"); await sendCard(client, message.chatId, buildTextCard({ text: control === "pause" ? "任务已暂停。" : "任务已恢复。" }, agent)); return; }
    await sendCard(client, message.chatId, buildTaskReceivedCard(agent, task.taskId, text));
    try {
      await onEvent({ type: "task_started", task_id: task.taskId, agent: agent.key, chat_id: message.chatId, project_name: task.projectName || null });
      // 任务记录里的项目名要与写入白名单同源，并随本轮交付回写，
      // 否则同一项目后续消息的白名单会退回 workspace/default。
      const result = await runAgent(agent, text, { taskId: task.taskId, chatId: message.chatId, appId: agent.appId, projectName: task.projectName || null, onEvent });
      if (result.cancelled || await isTerminated(task.taskId)) {
        await onEvent({ type: "task_cancelled", task_id: task.taskId, agent: agent.key, chat_id: message.chatId });
        return;
      }
      const projectName = result.projectName || result.delivery?.projectName || null;
      if (projectName && projectName !== task.projectName) await updateTask(task.taskId, { projectName });
      if (result.delivery) { await buildValidatedHandoff(result.delivery, { agentKey: agent.key, taskId: task.taskId }); await sendResultCard(client, message.chatId, { ...result, taskId: task.taskId }, { log }); if (orchestrator) await orchestrator.onTaskCompleted(agent.key, task.taskId, { delivery: result.delivery, resultText: result.text, context: { chatId: message.chatId, messageId: message.messageId, correlationId: message.messageId, requireHumanApproval: true, projectName }, approvalRequired: result.approvalRequired === true }); }
      else { await sendCard(client, message.chatId, buildTextCard(result, agent)); if (orchestrator) await orchestrator.onTaskCompleted(agent.key, task.taskId, { delivery: { agentKey: agent.key, agentName: agent.displayName, summary: result.text || "已完成交付", artifactPaths: [], final: false }, resultText: result.text, context: { chatId: message.chatId, messageId: message.messageId, correlationId: message.messageId, requireHumanApproval: true, projectName } }); }
      await onEvent({ type: "task_completed", task_id: task.taskId, agent: agent.key, chat_id: message.chatId, project_name: projectName, has_delivery: Boolean(result.delivery), artifact_count: result.delivery?.artifactPaths?.length || 0, final: result.delivery?.final === true });
    } catch (error) {
      if (await isTerminated(task.taskId)) {
        await onEvent({ type: "task_cancelled", task_id: task.taskId, agent: agent.key, chat_id: message.chatId });
        return;
      }
      await onEvent({ type: "task_failed", task_id: task.taskId, agent: agent.key, chat_id: message.chatId, error: error.message });
      log.error(`[${agent.key}] task failed: ${error.message}`);
      await sendCard(client, message.chatId, buildFailureCard(agent, error));
    }
  };
}
