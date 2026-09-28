import test from "node:test";
import assert from "node:assert/strict";
import { architectSkillPaths, buildPrompt, buildSystemPrompt, diagramSkillPaths, extractText, mapPiToolEvent } from "../src/pi-agent.js";

test("diagram-design skill 对架构设计师和项目经理启用", () => {
  assert.deepEqual(diagramSkillPaths("architect"), architectSkillPaths("architect"));
  assert.ok(diagramSkillPaths("architect").length > 0);
  assert.ok(diagramSkillPaths("project_manager").length > 0);
  assert.deepEqual(architectSkillPaths("frontend_developer"), []);
});

test("架构设计师提示词声明 diagram-design skill 与现有交付协议", () => {
  const prompt = buildSystemPrompt({ key: "architect", displayName: "架构设计师" });
  assert.match(prompt, /diagram-design skill/);
  assert.match(prompt, /nodes\/edges/);
});

test("项目经理提示词允许规划图但保留架构图归属约束", () => {
  const prompt = buildSystemPrompt({ key: "project_manager", displayName: "项目经理" });
  assert.match(prompt, /diagram-design skill/);
  assert.match(prompt, /final system architecture diagram/);
  assert.match(prompt, /diagram.*belongs to the architect/);
});

test("buildSystemPrompt 含身份、职责、工具与固定身份约束", () => {
  const prompt = buildSystemPrompt({ key: "tester", displayName: "测试" });
  assert.ok(prompt.includes("测试"));
  assert.ok(prompt.includes("tester"));
  assert.ok(prompt.includes("职责："));
  assert.ok(prompt.includes("身份是固定的"));
  assert.ok(prompt.includes("read"));
});

test("buildSystemPrompt 从 policy.json 读职责与工具", () => {
  const prompt = buildSystemPrompt({ key: "frontend_developer", displayName: "前端开发" });
  assert.ok(prompt.includes("前端页面")); // duty 来自 policy.json
  assert.ok(prompt.includes("write")); // 前端已放开 write/edit
  assert.ok(prompt.includes("edit"));
});

test("buildSystemPrompt 未配置角色 fallback 默认职责", () => {
  const prompt = buildSystemPrompt({ key: "unknown_role", displayName: "未知角色" });
  assert.ok(prompt.includes("处理飞书用户发来的任务"));
});

test("buildSystemPrompt 注入 workflow（项目经理）", () => {
  const prompt = buildSystemPrompt({ key: "project_manager", displayName: "项目经理" });
  assert.ok(prompt.includes("工作流程"));
  assert.ok(prompt.includes("澄清需求"));
  assert.ok(prompt.includes("产品职责"));
});

test("buildSystemPrompt 注入目标、约束与团队上下文", () => {
  const prompt = buildSystemPrompt({ key: "frontend_developer", displayName: "前端开发" });
  assert.ok(prompt.includes("目标："));
  assert.ok(prompt.includes("约束："));
  assert.ok(prompt.includes("团队角色："));
  assert.ok(prompt.includes("前端开发（你）")); // 团队列表标注自己
  assert.ok(prompt.includes("workspace/frontend")); // 约束里的写入范围
});

test("buildPrompt 含任务编号与指令，空指令 fallback", () => {
  const p = buildPrompt("做某事", { taskId: "T-1" });
  assert.ok(p.includes("T-1"));
  assert.ok(p.includes("做某事"));
  const p2 = buildPrompt("", { taskId: "T-2" });
  assert.ok(p2.includes("（未提供）"));
});

test("buildPrompt does not direct an unresolved project to workspace/default", () => {
  const prompt = buildPrompt("整理项目计划", { taskId: "T-3" });
  assert.equal(prompt.includes("workspace/default/artifacts"), false);
  assert.match(prompt, /create_project|项目目录/);
});

test("状态查询提示词固定传入根任务编号并禁止产物交付", () => {
  const prompt = buildPrompt("查询当前任务状态", { taskId: "root-status", chatId: "chat-status", statusQuery: true });
  assert.match(prompt, /root-status/);
  assert.match(prompt, /get_task_status/);
  assert.match(prompt, /不要调用 deliver_artifact/);
});

test("extractText 提取字符串 content", () => {
  assert.equal(extractText({ role: "assistant", content: "你好" }), "你好");
});

test("extractText 提取数组 content 里的 text 块", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "text", text: "第一句" },
      { type: "thinking", thinking: "忽略" },
      { type: "text", text: "第二句" },
    ],
  };
  assert.equal(extractText(msg), "第一句第二句");
});

test("extractText 空消息返回空串", () => {
  assert.equal(extractText(null), "");
  assert.equal(extractText({ role: "assistant", content: [] }), "");
});

test("Pi 工具事件映射为命令、文件变化和测试状态，不包含文件内容或工具输出", () => {
  const context = { taskId: "T-1:backend", parentTaskId: "T-1", agentKey: "backend_developer" };
  const start = mapPiToolEvent({
    type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm test" },
  }, context);
  assert.ok(start.some((event) => event.type === "tool_call" && event.command === "npm test"));
  assert.ok(start.some((event) => event.type === "test_started"));
  const result = mapPiToolEvent({
    type: "tool_execution_end", toolCallId: "c2", toolName: "write", isError: false,
    result: { content: [{ type: "text", text: "file content must not be logged" }] },
  }, context, { path: "src/auth.js", content: "secret file contents" });
  assert.deepEqual(result.map((event) => event.type), ["tool_result", "file_change"]);
  assert.equal(result[1].file_path, "src/auth.js");
  assert.equal(JSON.stringify(result).includes("secret file contents"), false);
  assert.equal(JSON.stringify(result).includes("file content must not be logged"), false);
});

test("Pi test result and errors are concise structured events", () => {
  const result = mapPiToolEvent({
    type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: true, result: { content: [{ text: "raw output" }] },
  }, { taskId: "T-2:tester", agentKey: "tester" }, { command: "pytest tests/auth" });
  assert.ok(result.some((event) => event.type === "test_result" && event.status === "failed"));
  assert.ok(result.some((event) => event.type === "error"));
  assert.equal(JSON.stringify(result).includes("raw output"), false);
});
