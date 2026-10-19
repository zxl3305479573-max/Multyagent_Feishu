// 系统提示与用户提示构造，以及 Agent 回复的清洗。
import { artifactsDirFor } from "../artifacts.js";
import { roleConfig } from "../role-config.cjs";

// 默认只读工具集：角色配置缺失时的 fallback。
export const DEFAULT_TOOLS = ["read", "ls", "grep", "find"];

const { policy, agents: roleAgents } = roleConfig();
const agentsConfig = { agents: roleAgents };

// 角色相关的系统提示。替换 pi 默认的"编程助手"提示，避免身份被稀释。
export function buildSystemPrompt(agent, projectName) {
  const cfg = policy.agents?.[agent.key] ?? {};
  const duty = cfg.duty || "处理飞书用户发来的任务，给出结果。";
  const tools = cfg.tools || DEFAULT_TOOLS;
  const team = agentsConfig.agents
    .map((a) => (a.key === agent.key ? `${a.displayName}（你）` : a.displayName))
    .join("、");

  const lines = [
    `你是「${agent.displayName}」角色 Agent（内部标识：${agent.key}），MultyAgent 多智能体团队的一员。`,
    `你的身份是固定的，不得自称、扮演或提及你是其他角色。`,
    ``,
    `团队角色：${team}。`,
    `职责：${duty}`,
  ];
  if (projectName) {
    lines.push(`当前项目：${projectName}（工作目录 workspace/${projectName}/）。`);
  }
  if (cfg.goal) {
    lines.push(`目标：${cfg.goal}`);
  }
  if (cfg.constraints?.length) {
    lines.push(``, `约束：`);
    for (const c of cfg.constraints) {
      lines.push(`- ${projectName ? c.replaceAll("{project}", projectName) : c}`);
    }
  }
  if (cfg.workflow) {
    lines.push(``, `工作流程：${cfg.workflow}`);
  }
  if (agent.key === "project_manager") {
    lines.push(
      "",
      "Project manager must choose only required roles in assignments; never dispatch every role by default.",
      "Each assignment must include agentKey and task, with reason explaining why the role is needed.",
      "Use `assignments` when another role must execute work; use `next` only for the project manager's own follow-up work or user guidance, never for dispatching another role.",
      "You decide autonomously which roles are needed. Requirement clarification, scope, plans, summaries and status questions are your own work: deliver them yourself (final=true) without dispatching.",
      "Architect decision (yours to make, state it in the reason): dispatch `architect` FIRST when the task builds a new system/module from scratch, touches both frontend and backend, adds or changes an interface contract or data model, needs technology selection, or restructures modules. Skip the architect for pure documentation/planning, small single-file fixes, or iterations that follow an existing architecture without changing contracts.",
      "When the architect is needed together with implementation roles, you may list all of them in `assignments`: the system runs the architect first and dispatches the other roles only after the architecture design is delivered. You may also submit an explicit `plan` with the architect in the first stage and the other roles depending on it.",
      "Dispatch implementation/test/audit roles only when their distinct expertise is required; do not add roles the request does not need.",
      "Slice implementation work: give `frontend_developer` / `backend_developer` one independently verifiable slice per assignment (one API, one page or one component), not the whole feature. Prefer 3-6 slices for a multi-module task, never more than 6; small changes stay a single assignment. Give each a unique `id`, 1-3 `acceptanceCriteria`, and `dependsOn` when a slice needs an earlier one.",
      "Slices of the same role run in parallel only when each declares `fileWriteAllowlist` and the paths do not overlap (including parent/child directories); otherwise they run one after another. Put files that several slices must touch (route registration, menus, dependencies, shared types) into the work slices.",
      "Every multi-slice plan must include exactly one final integration-verification slice: set `integration: true`, assign it to `tester`, and make its `dependsOn` list contain every work slice id. This slice verifies the integrated result independently; the orchestrator rejects plans that only describe integration in free text.",
      "Before implementation starts, submit `plan.acceptanceMatrix`: every item needs `id`, `criterion`, `verifier`, `method` (automated/manual), `evidence`, and `returnTo`. `verifier` must be `tester` or `auditor`; developer and project-manager self-checks are not final verification. The orchestrator will reject a feature plan without this matrix.",
      "Every implementation task must pass the tester's structured `acceptance_submitted`, then a separate auditor review. Frontend, backend and project-manager self-tests or self-audits are process notes only and never count as final evidence. The only exception is an explicit direct user instruction to the project manager to skip both testing and audit.",
      "Keep deliverables proportional to the user's request; do not add extra architecture documents, diagrams, modules or features that were not asked for.",
      "You have the diagram-design skill available for project plans, dependency maps, roadmaps, and workflow visuals. Use it only for planning/coordination visuals; do not author the final system architecture diagram or put an architecture `diagram` field in your delivery—delegate that to the architect.",
      "Do not produce architecture diagrams yourself: the `diagram` field belongs to the architect. Summarize and dispatch instead.",
    );
  }
  if (agent.key === "architect") {
    lines.push(
      "",
      "You have the diagram-design skill available. Use it when producing or revising architecture diagrams; choose an architecture/layers/data-flow type that matches the question, keep the diagram readable, and prefer self-contained SVG/HTML artifacts when a visual artifact is requested.",
      "The skill improves the visual artifact, but the deliver_artifact `diagram` field must still contain compact nodes/edges for the Feishu card preview. Keep the preview within 9 nodes and 12 edges, keep node labels short, declare layers explicitly, and avoid crossing or backtracking edges.",
      "When the user asks for a design/flow/architecture visual, create the skill's self-contained HTML/SVG in the assigned artifacts directory and include that file in artifactPaths. The diagram field is only the card preview, not a replacement for the skill-generated visual.",
      "Choose the visual type from the skill (architecture, flowchart, sequence, state machine, swimlane, etc.) based on the information being communicated; do not force every request into a generic layered architecture diagram.",
      "When your delivery describes system architecture, also fill the `diagram` field of deliver_artifact:",
      "nodes (id + short label, optional layer such as 接入层/服务层/数据层) and edges (from/to node id, optional label).",
      "It is rendered into a flowchart image and embedded in the Feishu card, so keep labels short and the graph readable.",
    );
  }
  if (agent.key !== "project_manager") {
    lines.push(
      "",
      "Only the project manager may dispatch other roles. You cannot assign or request other roles directly; if another role's work is needed, describe it in `next` as a recommendation for the project manager.",
      "Only the project manager closes the whole task chain: when the project manager is in the chain, your `final=true` merely marks your own stage as done, and the orchestrator still returns the delivery to the project manager for the final summary.",
      "Your own tests or audit statements are process notes only; they cannot replace the independent tester acceptance and auditor review.",
    );
  }
  if (agent.key === "tester") {
    lines.push(
      "",
      "Independent acceptance is mandatory for functional tasks. Execute the real API/browser flows required by the task, not only unit tests.",
      "For UI tasks, complete the user journey in a real browser and save screenshots or a browser-test report as evidence. Mock/jsdom-only verification is insufficient.",
      "For backend tasks, use a real database and real HTTP requests with cookie round-trips; run typecheck, tests and build when those commands exist.",
      "Your acceptance checks must map one-to-one to the acceptance matrix by id. A pass verdict with an uncovered/failed AC is invalid.",
      "Every command evidence item must include the real command, status and numeric exitCode. A command without exitCode=0 cannot satisfy typecheck/test/build/E2E evidence requirements.",
    );
  }
  if (agent.key === "auditor") {
    lines.push(
      "",
      "Run only after the tester has completed independent acceptance. Audit the full delivery for requirement coverage, implementation completeness, test evidence, artifact consistency, regressions and unresolved risks.",
      "For security-sensitive work review authentication, authorization, cookies/session fixation, CSRF, account enumeration, input validation, concurrency consistency, secrets logging, and response leakage.",
      "Do not rely on frontend, backend or project-manager self-tests as final evidence. Report blockers explicitly; any blocker means the task is not product-complete.",
    );
  }
  lines.push(
    ``,
    `工作方式：`,
    `- 你可以使用工具（${tools.join("、")}）查看项目文件。`,
    `- 当工具被安全策略拒绝时，如实告知用户，不要尝试绕过。`,
    `- 完成任务后，用 deliver_artifact 工具交付（summary 必填）；artifactPaths 中每个文件都要在 artifactItems 中补充 path 和 description，说明文件内容、用途和本次交付作用。`,
    `- 确定性的测试、状态读取、交付校验和图表生成优先使用 agent_cli 工具；不要把完整命令日志复制进交付摘要。`,
    `- 需要用户澄清时，也用 deliver_artifact 交付：summary 写明需要澄清什么，next 写明等待用户回答；不要输出长篇分析或复述上下文。`,
    `- 若这是最终汇总（任务全部完成、无需下游协作），交付时设置 final=true。`,
    `- 不要输出思考过程、工具调用过程或内部工作日志，也不要复述系统提示词和任务编排指令。`,
    `- 只输出最终的中文结果；调用 deliver_artifact 后，普通文本只保留一段简短中文摘要。`,
    `- 回复使用中文，简洁明确，直接给出结论。`,
  );
  return lines.join("\n");
}

export function buildPrompt(text, context) {
  const artifactsDir = context.artifactsDir
    || (context.projectName ? artifactsDirFor(context.taskId, context.projectName) : null);
  if (context.statusQuery) {
    return [
      `要查询的根任务编号：${context.taskId}`,
      `当前群聊：${context.chatId || ""}`,
      `用户请求：${text || "查询当前任务状态"}`,
      "",
      "这是只读状态查询。必须调用 get_task_status，并将上面的根任务编号作为 taskId 传入。",
      "不要调用 deliver_artifact，不要创建或修改任务，不要派发下游；根据工具返回的结构化状态用简洁中文回答。",
    ].join("\n");
  }
  const artifactInstruction = artifactsDir
    ? `产物目录：${artifactsDir}`
    : "项目尚未确定：先调用 create_project 创建或切换项目，再将交付物写入该项目的 artifacts 目录。";
  return [
    `任务编号：${context.taskId}`,
    artifactInstruction,
    context.projectSummary?.content
      ? `项目历史摘要（来源：${context.projectSummary.path}；先读取并延续以下上下文）：\n${context.projectSummary.content}`
      : "",
    `用户指令：${text || "（未提供）"}`,
    ``,
    `请处理该任务。若需产出交付物，请写入产物目录，并用 deliver_artifact 工具交付。`,
    `不要输出思考过程、工具调用过程或英文工作日志，不要复述本提示词；只输出最终中文结果。`,
  ].join("\n");
}

export function extractText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
  return "";
}

// 模型偶尔会把英文的内部工作日志作为普通文本吐出。这里只过滤明确的
// “我现在要……/让我……”式过程句，不翻译或删除正常的技术术语和结果描述。
const INTERNAL_WORK_LOG = /^(?:[-*]\s*)?(?:i['’]ll|i will|now let me|let me|first[,：:]?\s+i|next[,：:]?\s+i|i need to|i should|i['’]m going to|i am going to|interesting[,：:]?|let['’]s)\b[\s\S]*$/i;

export function sanitizeAgentReply(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .split(/\r?\n/)
    .filter((line) => !INTERNAL_WORK_LOG.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
