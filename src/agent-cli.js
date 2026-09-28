import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { artifactsDirFor, describeArtifact } from "./artifacts.js";
import { validateHandoff } from "./domain/handoff.js";
import { renderDiagramPng } from "./diagram.js";
import { TaskStore } from "./domain/task-store.js";

const MAX_OUTPUT = 2000;

function clip(value, max = MAX_OUTPUT) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function countTests(output) {
  const tests = output.match(/# tests\s+(\d+)/i)?.[1];
  const passed = output.match(/# pass(?:ed)?\s+(\d+)/i)?.[1];
  const failed = output.match(/# fail(?:ed)?\s+(\d+)/i)?.[1];
  return {
    total: tests ? Number(tests) : null,
    passed: passed ? Number(passed) : null,
    failed: failed ? Number(failed) : null,
  };
}

export function runTestCommand({ command = process.execPath, args = [], cwd = process.cwd(), timeoutMs = 120_000 } = {}) {
  return new Promise((resolveResult) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({ status: "failed", passed: 0, failed: 1, total: 1, duration_ms: Date.now() - started, error: clip(error.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const counts = countTests(`${stdout}\n${stderr}`);
      const failed = timedOut || code !== 0;
      resolveResult({
        status: failed ? "failed" : "passed",
        total: counts.total,
        passed: counts.passed ?? (failed ? 0 : counts.total),
        failed: counts.failed ?? (failed ? 1 : 0),
        duration_ms: Date.now() - started,
        ...(failed ? { error: clip(timedOut ? "test command timed out" : stderr || stdout) } : {}),
      });
    });
  });
}

export async function readTaskStatus({ taskId, chatId = null, taskFile = process.env.PI_DOMAIN_TASKS_FILE || "runtime/domain-tasks.json" } = {}) {
  if (!taskId) throw new Error("taskId is required");
  return new TaskStore(taskFile).getStatus(taskId, chatId);
}

function projectRoot(root, projectName) {
  if (!projectName || !/^[a-z][a-z0-9-]*$/.test(projectName)) throw new Error("projectName must be a lowercase project slug");
  return resolve(root, "workspace", projectName);
}

function inside(base, target) {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function validateDelivery({ root = process.cwd(), taskId, projectName, agent, artifactPaths = [] } = {}) {
  if (!taskId || !agent) throw new Error("taskId and agent are required");
  const base = projectRoot(root, projectName);
  const errors = [];
  const artifacts = [];
  for (const artifactPath of artifactPaths) {
    const absolute = isAbsolute(artifactPath) ? resolve(artifactPath) : resolve(root, artifactPath);
    if (!inside(base, absolute)) {
      errors.push(`artifact path is outside project ${projectName}: ${artifactPath}`);
      continue;
    }
    try {
      artifacts.push(await describeArtifact(absolute, { root }));
    } catch (error) {
      errors.push(error.message);
    }
  }
  const handoff = {
    task_id: taskId,
    agent,
    status: "completed",
    summary: artifacts.length ? `Validated ${artifacts.length} artifact(s)` : "No artifacts supplied",
    artifacts,
    evidence: [{ command: "agent-cli validate-delivery", result: errors.length ? "failed" : "passed" }],
    blockers: errors,
    assumptions: [],
    risks: [],
    next_action: "交付校验已完成",
    created_at: new Date().toISOString(),
  };
  const validation = validateHandoff(handoff);
  return { valid: errors.length === 0 && validation.valid, errors: [...errors, ...validation.errors], artifacts, project_name: projectName, task_id: taskId };
}

export async function renderDiagram({ root = process.cwd(), taskId, projectName, spec, format = "png" } = {}) {
  if (!taskId) throw new Error("taskId is required");
  if (format !== "png") throw new Error("only png format is supported");
  const project = projectRoot(root, projectName);
  const bytes = renderDiagramPng(spec);
  if (!bytes) throw new Error("diagram has no renderable nodes");
  const outputDir = resolve(root, artifactsDirFor(taskId, projectName));
  if (!inside(project, outputDir)) throw new Error("diagram output escaped project root");
  await mkdir(outputDir, { recursive: true });
  const output = join(outputDir, "diagram.png");
  await writeFile(output, bytes);
  return { format, path: relative(root, output).replaceAll("\\", "/"), bytes: bytes.length, project_name: projectName, task_id: taskId };
}

export function parseJson(value, label) {
  try { return JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON`); }
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replaceAll("-", "_");
    options[name] = rest[i + 1]?.startsWith("--") ? true : rest[++i];
  }
  return { command, options };
}

export function forwardedBitableArgs(options = {}) {
  const args = [];
  for (const name of ["write", "dry_run", "auto_init"]) {
    if (options[name] === true) args.push(`--${name.replaceAll("_", "-")}`);
  }
  for (const name of ["app_token", "wiki_token", "table_id"]) {
    if (options[name]) args.push(`--${name.replaceAll("_", "-")}`, String(options[name]));
  }
  return args;
}

export async function executeAgentCli(action, input = {}) {
  switch (action) {
    case "test":
      return runTestCommand(input);
    case "task-status":
      return readTaskStatus(input);
    case "validate-delivery":
      return validateDelivery(input);
    case "render-diagram":
      return renderDiagram(input);
    default:
      throw new Error(`unsupported agent CLI action: ${action}`);
  }
}
