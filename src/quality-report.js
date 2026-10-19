import { join } from "node:path";
import { writeFileAtomic } from "./atomic-file.cjs";
import { artifactsDirFor } from "./artifacts.js";
import {
  QUALITY_LABELS,
  evaluateAcceptanceMatrix,
  missingAcceptanceEvidence,
  qualityGateReady,
  qualityStatusLabel,
} from "./quality-gates.js";

function acceptanceSummary(gates = {}) {
  const entries = (Array.isArray(gates.evidence) ? gates.evidence : []).filter((item) => item.kind === "independent_acceptance");
  const latest = entries.at(-1) || null;
  return {
    status: gates.independent_acceptance || "pending",
    verdict: latest?.verdict || null,
    checks: Number(latest?.checks || 0),
    checkResults: Array.isArray(latest?.check_results) ? latest.check_results : [],
    failedChecks: Array.isArray(latest?.failed_checks) ? latest.failed_checks : [],
    evidence: Array.isArray(latest?.evidence) ? latest.evidence : [],
  };
}

function dedupeEvidence(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = JSON.stringify([item.kind, item.command, item.exitCode, item.path, item.url, item.text]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function commandLabel(item) {
  const command = item.command || item.text || item.path || item.url || "未记录命令";
  const exitCode = item.exitCode ?? item.exit_code;
  return `${command}（退出码 ${exitCode === undefined || exitCode === null ? "未记录" : exitCode}）`;
}

export function qualityReportFilesFor(task) {
  const dir = artifactsDirFor(task.task_id, task.project_name || null);
  return {
    jsonFile: join(dir, "quality-report.json"),
    markdownFile: join(dir, "quality-report.md"),
  };
}

/**
 * Build the final status exclusively from structured task gates. `productReady`
 * can be computed one step before the root settlement event; the persisted
 * report is generated after settlement, when `product` is already passed.
 */
export function buildQualityReport({ task, settlementPending = false } = {}) {
  if (!task?.task_id) throw new Error("quality report requires task");
  const gates = task.quality_gates || {};
  const policy = gates.policy || task.quality_policy || {};
  const acceptance = acceptanceSummary(gates);
  const matrix = Array.isArray(gates.acceptance_matrix) ? gates.acceptance_matrix : [];
  const coverage = evaluateAcceptanceMatrix(matrix, { checks: acceptance.checkResults });
  const requiredEvidence = Array.isArray(policy.requiredEvidence) ? policy.requiredEvidence : [];
  const missingEvidence = missingAcceptanceEvidence({ evidence: acceptance.evidence }, requiredEvidence);
  const allEvidence = dedupeEvidence([
    ...(Array.isArray(gates.evidence) ? gates.evidence.flatMap((item) => item.evidence || []) : []),
    ...acceptance.evidence,
  ]);
  const commands = allEvidence.filter((item) => item.kind === "command" || item.command);
  const keyEvidence = allEvidence.filter((item) => ["screenshot", "file", "url"].includes(item.kind));
  const gateReady = qualityGateReady(gates);
  const productReady = gateReady && (gates.product === "passed" || settlementPending === true);
  const risks = [...new Set([
    ...(Array.isArray(task.status_snapshot?.risks) ? task.status_snapshot.risks : []),
    ...(Array.isArray(task.risks) ? task.risks : []),
  ].filter(Boolean))];
  const uncovered = [...new Set([
    ...coverage.uncovered.map((id) => `${id} 未覆盖`),
    ...missingEvidence.map((kind) => `缺少 ${kind} 命令证据`),
  ])];
  const files = qualityReportFilesFor(task);
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    taskId: task.task_id,
    projectName: task.project_name || null,
    title: task.title || "",
    applicable: policy.independentAcceptance === true || policy.acceptanceMatrix === true,
    policy,
    stages: {
      implementation: gates.implementation || "pending",
      self_test: gates.self_test || "pending",
      independent_acceptance: gates.independent_acceptance || "pending",
      audit: gates.audit || "not_required",
      product: settlementPending && gateReady && gates.product !== "passed" ? "ready_to_settle" : (gates.product || "incomplete"),
    },
    acceptanceMatrix: matrix.map((item) => ({
      ...item,
      result: coverage.results.find((result) => result.id === item.id)?.status || "missing",
    })),
    acceptance: {
      ...acceptance,
      passedCount: coverage.passed,
      failedCount: coverage.failed,
      uncoveredCount: coverage.uncovered.length,
      failedIds: coverage.failedIds,
      uncoveredIds: coverage.uncovered,
    },
    requiredEvidence,
    missingEvidence,
    commands,
    keyEvidence,
    evidence: Array.isArray(gates.evidence) ? gates.evidence : [],
    uncovered,
    risks,
    productReady,
    settlementPending: settlementPending === true && gateReady && gates.product !== "passed",
    reportFiles: files,
  };
}

function markdown(report) {
  const stageRows = Object.entries(report.stages)
    .map(([key, status]) => `| ${QUALITY_LABELS[key] || key} | ${qualityStatusLabel(status)} |`)
    .join("\n");
  const matrixRows = report.acceptanceMatrix.length
    ? report.acceptanceMatrix.map((item) => `| ${item.id} | ${item.criterion} | ${item.verifier} | ${qualityStatusLabel(item.result)} |`).join("\n")
    : "| - | 未提交验收矩阵 | - | 未覆盖 |";
  const commands = report.commands.length
    ? report.commands.map((item) => `- ${commandLabel(item)}`).join("\n")
    : "- 无结构化命令证据";
  const keyEvidence = report.keyEvidence.length
    ? report.keyEvidence.map((item) => `- ${item.kind}：${item.path || item.url || item.text || "未注明"}`).join("\n")
    : "- 无截图、接口或文件证据";
  const risks = report.risks.length ? report.risks.map((risk) => `- ${risk}`).join("\n") : "- 未记录";
  const uncovered = report.uncovered.length ? report.uncovered.map((item) => `- ${item}`).join("\n") : "- 无";
  return [
    "# 质量门禁报告",
    "",
    `- 任务：${report.taskId}`,
    `- 项目：${report.projectName || "未指定"}`,
    `- 生成时间：${report.generatedAt}`,
    `- 可进入产品闭环：${report.productReady ? "是" : "否"}`,
    "",
    "## 完成状态",
    "",
    "| 阶段 | 状态 |",
    "| --- | --- |",
    stageRows,
    "",
    "## 验收矩阵",
    "",
    "| AC | 检查内容 | 验证者 | 结果 |",
    "| --- | --- | --- | --- |",
    matrixRows,
    "",
    `- 通过：${report.acceptance.passedCount}`,
    `- 失败：${report.acceptance.failedCount}`,
    `- 未覆盖：${report.acceptance.uncoveredCount}`,
    "",
    "## 测试命令与退出码",
    "",
    commands,
    "",
    "## 截图、接口与文件证据",
    "",
    keyEvidence,
    "",
    "## 未覆盖项",
    "",
    uncovered,
    "",
    "## 已知风险",
    "",
    risks,
    "",
    "## 上线结论",
    "",
    report.productReady ? "- 可以上线。" : "- 不可上线；必须先补齐失败或未覆盖的门禁。",
    report.settlementPending ? "- 当前等待根任务结算写入产品闭环状态。" : "",
    "",
    "> 本报告只读取结构化门禁、检查结果和证据记录；项目经理自由文本不能覆盖上述状态。",
    "",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}

/** Render the same structured facts into the project manager's final delivery. */
export function formatQualityReportSummary(report) {
  if (!report?.applicable) return "";
  const stageLine = Object.entries(report.stages)
    .map(([key, status]) => `${QUALITY_LABELS[key] || key} ${qualityStatusLabel(status)}`)
    .join("；");
  const commands = report.commands.length
    ? report.commands.map((item) => commandLabel(item)).join("；")
    : "未记录";
  const keyEvidence = report.keyEvidence.length
    ? report.keyEvidence.map((item) => `${item.kind} ${item.path || item.url || item.text || "未注明"}`).join("；")
    : "未记录";
  return [
    "质量门禁（系统统计）：",
    `- AC：通过 ${report.acceptance.passedCount}，失败 ${report.acceptance.failedCount}，未覆盖 ${report.acceptance.uncoveredCount}`,
    `- 阶段：${stageLine}`,
    `- 测试命令：${commands}`,
    `- 关键证据：${keyEvidence}`,
    `- 未覆盖项：${report.uncovered.join("；") || "无"}`,
    `- 已知风险：${report.risks.join("；") || "无"}`,
    `- 上线结论：${report.productReady ? "可以上线" : "不可上线"}`,
    `- 质量报告：${report.reportFiles.markdownFile}；${report.reportFiles.jsonFile}`,
  ].join("\n");
}

export async function generateQualityReport({ task } = {}) {
  const report = buildQualityReport({ task });
  await writeFileAtomic(report.reportFiles.jsonFile, `${JSON.stringify(report, null, 2)}\n`);
  await writeFileAtomic(report.reportFiles.markdownFile, `${markdown(report)}\n`);
  return {
    report,
    jsonFile: report.reportFiles.jsonFile,
    markdownFile: report.reportFiles.markdownFile,
  };
}
