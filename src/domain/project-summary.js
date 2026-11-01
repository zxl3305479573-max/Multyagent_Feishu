// 项目阶段摘要：编排层在每个阶段交付后自动追加，供项目切换和后续任务恢复上下文。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const PROJECT_SLUG = /^[a-z][a-z0-9-]*$/;
const DEFAULT_MAX_CHARS = 6000;

function headerFor(projectName) {
  return `# 项目摘要：${projectName}\n\n> 由编排层在每个阶段交付后自动追加，供项目切换和后续任务恢复上下文。\n`;
}

function assertProjectName(projectName) {
  const project = String(projectName || "").trim();
  if (!PROJECT_SLUG.test(project)) throw new Error(`Invalid project name: ${projectName}`);
  return project;
}

export function summaryFileFor({ root = process.cwd(), projectName } = {}) {
  return join(resolve(root), "workspace", assertProjectName(projectName), "artifacts", "PROJECT_SUMMARY.md");
}

function stageMarker(taskId, agentKey) {
  return `<!-- stage:${taskId}:${agentKey} -->`;
}

function stageSection({ taskId, agentKey, agentName, delivery = {}, resultText = "", at = new Date().toISOString() }) {
  const artifacts = Array.isArray(delivery.artifactPaths) ? delivery.artifactPaths : [];
  const evidence = Array.isArray(delivery.evidence) ? delivery.evidence : [];
  const blockers = Array.isArray(delivery.blockers) ? delivery.blockers : [];
  const risks = Array.isArray(delivery.risks) ? delivery.risks : [];
  const summary = String(delivery.summary || resultText || "").trim() || "（无摘要）";
  const lines = [
    `## ${at} | ${agentName || agentKey} | ${taskId}`,
    `- 阶段结论：${summary}`,
    artifacts.length ? `- 产物：${artifacts.map((item) => `\`${item}\``).join("、")}` : "- 产物：无",
  ];
  if (evidence.length) {
    lines.push(`- 验证证据：${evidence.map((item) => `${item.command || ""} → ${item.result || ""}`).join("；")}`);
  }
  if (blockers.length) lines.push(`- 阻塞：${blockers.join("；")}`);
  if (risks.length) lines.push(`- 风险：${risks.join("；")}`);
  if (String(delivery.next || "").trim()) lines.push(`- 下一步：${String(delivery.next).trim()}`);
  lines.push(`- 状态：${delivery.final === true ? "最终交付" : "阶段完成"}`);
  lines.push("");
  lines.push(stageMarker(taskId, agentKey));
  return lines.join("\n");
}

export async function appendProjectSummary({ root, projectName, taskId, agentKey, agentName, delivery, resultText, at } = {}) {
  const file = summaryFileFor({ root, projectName });
  const marker = stageMarker(taskId, agentKey);
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing.includes(marker)) return { appended: false, path: file };
  await mkdir(dirname(file), { recursive: true });
  const body = existing.trim() || headerFor(assertProjectName(projectName)).trim();
  const section = stageSection({ taskId, agentKey, agentName, delivery, resultText, at });
  await writeFile(file, `${body}\n\n${section}\n`);
  return { appended: true, path: file };
}

export async function readProjectSummary({ root, projectName, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const file = summaryFileFor({ root, projectName });
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const limit = Math.max(50, Number(maxChars) || DEFAULT_MAX_CHARS);
  if (content.length <= limit) return { path: file, content, truncated: false };
  return {
    path: file,
    content: `（已截断，仅保留最近阶段；完整内容见 ${file}）\n\n${content.slice(-limit)}`,
    truncated: true,
  };
}
