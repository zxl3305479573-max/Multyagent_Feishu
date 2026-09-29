import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendProjectSummary, readProjectSummary, summaryFileFor } from "../src/project-summary.js";

test("summaryFileFor 只允许合法项目名并落在项目 artifacts 目录", () => {
  const file = summaryFileFor({ root: "D:/repo", projectName: "student" });
  assert.match(file, /workspace[\\/]student[\\/]artifacts[\\/]PROJECT_SUMMARY\.md$/);
  assert.throws(() => summaryFileFor({ root: "D:/repo", projectName: "../escape" }), /Invalid project name/);
  assert.throws(() => summaryFileFor({ root: "D:/repo", projectName: "" }), /Invalid project name/);
});

test("appendProjectSummary 每个阶段追加一次且重复调用不重复写入", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-summary-"));
  try {
    const first = await appendProjectSummary({
      root,
      projectName: "student",
      taskId: "T-1",
      agentKey: "project_manager",
      agentName: "项目经理",
      delivery: {
        summary: "需求规格完成",
        artifactPaths: ["workspace/student/artifacts/T-1/spec.md"],
        next: "派发架构设计",
        risks: ["验收标准待确认"],
        final: false,
      },
    });
    assert.equal(first.appended, true);
    const second = await appendProjectSummary({
      root,
      projectName: "student",
      taskId: "T-1",
      agentKey: "project_manager",
      agentName: "项目经理",
      delivery: { summary: "需求规格完成" },
    });
    assert.equal(second.appended, false, "同一阶段重复交付不应重复追加");

    const content = await readFile(first.path, "utf8");
    assert.match(content, /项目摘要：student/);
    assert.match(content, /需求规格完成/);
    assert.equal(content.match(/需求规格完成/g).length, 1);

    const other = await appendProjectSummary({
      root,
      projectName: "student",
      taskId: "T-2",
      agentKey: "architect",
      agentName: "架构设计师",
      delivery: { summary: "架构方案完成", artifactPaths: ["workspace/student/artifacts/T-2/architecture.md"] },
    });
    assert.equal(other.appended, true);
    const both = await readProjectSummary({ root, projectName: "student" });
    assert.match(both.content, /需求规格完成/);
    assert.match(both.content, /架构方案完成/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readProjectSummary 缺失返回 null，超长时保留最近阶段并标记截断", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-summary-read-"));
  try {
    assert.equal(await readProjectSummary({ root, projectName: "student" }), null);
    await appendProjectSummary({
      root,
      projectName: "student",
      taskId: "T-latest",
      agentKey: "tester",
      agentName: "测试",
      delivery: { summary: "最近一次测试通过", artifactPaths: [] },
    });
    const result = await readProjectSummary({ root, projectName: "student", maxChars: 60 });
    assert.equal(result.truncated, true);
    assert.match(result.content, /最近一次测试通过/);
    assert.match(result.content, /已截断/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
