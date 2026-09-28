import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../src/domain/task-store.js";
import { executeAgentCli, forwardedBitableArgs, renderDiagram, runTestCommand, readTaskStatus, validateDelivery } from "../src/agent-cli.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("runTestCommand returns a bounded structured test summary", async () => {
  const result = await runTestCommand({
    command: process.execPath,
    args: ["-e", "console.log('# tests 2'); console.log('# pass 2'); console.log('# fail 0')"],
    cwd: repoRoot,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.passed, 2);
  assert.equal(result.failed, 0);
  assert.equal(typeof result.duration_ms, "number");
  assert.ok(!Object.hasOwn(result, "output") || result.output.length <= 2000);
});

test("readTaskStatus reads the persisted snapshot without changing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-cli-status-"));
  const file = join(dir, "tasks.json");
  try {
    const store = new TaskStore(file);
    await store.create({ task_id: "T-cli", agent: "project_manager", source_chat_id: "chat-cli", project_name: "student" });
    await store.applyEvent({ type: "task_started", task_id: "T-cli", agent: "project_manager", project_name: "student" });
    const before = await readFile(file, "utf8");
    const status = await readTaskStatus({ taskId: "T-cli", chatId: "chat-cli", taskFile: file });
    const after = await readFile(file, "utf8");
    assert.equal(status.task_id, "T-cli");
    assert.equal(status.project_name, "student");
    assert.equal(after, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateDelivery accepts current-project artifacts and rejects another project", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-cli-delivery-"));
  try {
    await mkdir(join(root, "workspace", "student", "artifacts", "T-cli"), { recursive: true });
    await writeFile(join(root, "workspace", "student", "artifacts", "T-cli", "plan.md"), "plan");
    const valid = await validateDelivery({
      root,
      taskId: "T-cli",
      projectName: "student",
      agent: "project_manager",
      artifactPaths: ["workspace/student/artifacts/T-cli/plan.md"],
    });
    assert.equal(valid.valid, true);
    assert.equal(valid.artifacts[0].path, "workspace/student/artifacts/T-cli/plan.md");

    const invalid = await validateDelivery({
      root,
      taskId: "T-cli",
      projectName: "student",
      agent: "project_manager",
      artifactPaths: ["workspace/other/artifacts/T-cli/plan.md"],
    });
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors[0], /project|项目/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderDiagram writes only inside the requested project artifact directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-cli-diagram-"));
  try {
    const result = await renderDiagram({
      root,
      taskId: "T-cli",
      projectName: "student",
      spec: { nodes: [{ id: "a", label: "A" }], edges: [] },
    });
    assert.equal(result.format, "png");
    assert.match(result.path, /workspace[\\/]student[\\/]artifacts[\\/]T-cli[\\/]diagram\.png$/);
    const png = await readFile(join(root, result.path));
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent CLI test command returns JSON and a nonzero exit code on failure", async () => {
  const script = fileURLToPath(new URL("../scripts/agent-cli.mjs", import.meta.url));
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script, "test", "--command", process.execPath, "--args", "-e", "process.exit(3)"], { cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "failed");
});

test("forwardedBitableArgs keeps only supported maintenance flags", () => {
  assert.deepEqual(forwardedBitableArgs({ write: true, table_id: "tbl-1", action: "check" }), ["--write", "--table-id", "tbl-1"]);
});

test("executeAgentCli exposes only the structured actions used by agents", async () => {
  const result = await executeAgentCli("test", { command: process.execPath, args: ["-e", "process.exit(0)"] });
  assert.equal(result.status, "passed");
  await assert.rejects(() => executeAgentCli("shell", {}), /unsupported agent CLI action/);
});
