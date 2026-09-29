import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { architectSkillPaths, buildPrompt, buildSystemPrompt, createAgentCliTool, createProjectTool, diagramSkillPaths, extractText, mapPiToolEvent, normalizeAssignments, sanitizeAgentReply } from "../src/pi-agent.js";
import { appendProjectSummary } from "../src/project-summary.js";

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
  assert.match(prompt, /9 nodes and 12 edges/);
  assert.match(prompt, /self-contained HTML\/SVG/);
  assert.match(prompt, /visual type/);
});

test("项目经理提示词允许规划图但保留架构图归属约束", () => {
  const prompt = buildSystemPrompt({ key: "project_manager", displayName: "项目经理" });
  assert.match(prompt, /diagram-design skill/);
  assert.match(prompt, /final system architecture diagram/);
  assert.match(prompt, /diagram.*belongs to the architect/);
});

test("项目经理提示词要求最小派发并避免超出需求的交付", () => {
  const prompt = buildSystemPrompt({ key: "project_manager", displayName: "项目经理" });
  assert.match(prompt, /Default to zero downstream assignments/);
  assert.match(prompt, /never dispatch more than two roles/);
  assert.match(prompt, /do not add extra architecture documents/);
});

test("normalizeAssignments 过滤自身并将单次派发限制在三个角色内", () => {
  const result = normalizeAssignments([
    { agentKey: "project_manager", task: "自己继续" },
    { agentKey: "architect", task: "架构设计", reason: "需要模块边界" },
    { agentKey: "frontend_developer", task: "前端实现" },
    { agentKey: "backend_developer", task: "后端实现" },
    { agentKey: "tester", task: "测试" },
    { agentKey: "auditor", task: "审计" },
  ], { selfAgentKey: "project_manager" });
  assert.deepEqual(result.map((item) => item.agentKey), ["architect", "frontend_developer", "backend_developer"]);
  assert.deepEqual(normalizeAssignments([{ agentKey: "tester", task: "复验" }], { allowDispatch: false }), []);
});

test("非项目经理提示词声明不能直接派发其他角色", () => {
  const prompt = buildSystemPrompt({ key: "architect", displayName: "架构设计师" });
  assert.match(prompt, /Only the project manager may dispatch other roles/);
});

test("createProjectTool 切换项目时自动读取并返回历史摘要", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-project-summary-"));
  try {
    await appendProjectSummary({
      root,
      projectName: "phone-login",
      taskId: "T-old",
      agentKey: "architect",
      agentName: "架构设计师",
      delivery: { summary: "旧项目架构已定", artifactPaths: [] },
    });
    const tool = createProjectTool({ root, onProject: () => {} });
    const result = await tool.execute("call", { name: "phone-login" });
    assert.match(result.content[0].text, /历史项目摘要/);
    assert.match(result.content[0].text, /旧项目架构已定/);
    assert.equal(result.details.projectSummary, join(root, "workspace", "phone-login", "artifacts", "PROJECT_SUMMARY.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildSystemPrompt 含身份、职责、工具与固定身份约束", () => {
  const prompt = buildSystemPrompt({ key: "tester", displayName: "测试" });
  assert.ok(prompt.includes("测试"));
  assert.ok(prompt.includes("tester"));
  assert.ok(prompt.includes("职责："));
  assert.ok(prompt.includes("身份是固定的"));
  assert.ok(prompt.includes("read"));
});

test("buildSystemPrompt 明确禁止展示英文内部工作日志并要求最终中文", () => {
  const prompt = buildSystemPrompt({ key: "tester", displayName: "测试" });
  assert.match(prompt, /不要输出思考过程、工具调用过程或内部工作日志/);
  assert.match(prompt, /只输出最终的中文结果/);
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

test("buildPrompt 要求只返回中文最终结果", () => {
  const prompt = buildPrompt("检查接口", { taskId: "T-output" });
  assert.match(prompt, /不要输出思考过程、工具调用过程或英文工作日志/);
  assert.match(prompt, /只输出最终中文结果/);
});

test("buildPrompt 注入项目历史摘要供切换后续接上下文", () => {
  const prompt = buildPrompt("继续实现", {
    taskId: "T-sum",
    projectSummary: {
      path: "workspace/student/artifacts/PROJECT_SUMMARY.md",
      content: "阶段结论：需求规格完成",
    },
  });
  assert.match(prompt, /项目历史摘要/);
  assert.match(prompt, /需求规格完成/);
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

test("sanitizeAgentReply 删除英文内部工作日志但保留技术结果", () => {
  const reply = [
    "I'll start by surveying the artifacts.",
    "Now let me read the backend delivery report.",
    "已完成接口联调，Node.js API 测试通过。",
    "Let me independently verify the result.",
  ].join("\n");
  assert.equal(sanitizeAgentReply(reply), "已完成接口联调，Node.js API 测试通过。");
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

test("agent_cli 在执行时读取最新项目名和群聊 ID", async () => {
  let projectName = null;
  let received;
  const tool = createAgentCliTool({
    taskId: "T-cli",
    getProjectName: () => projectName,
    chatId: "chat-cli",
    agentKey: "project_manager",
    execute: async (_action, input) => {
      received = input;
      return { status: "passed" };
    },
  });

  projectName = "student";
  const result = await tool.execute("call-1", { action: "task-status", command: "cmd.exe", args: ["/c", "whoami"] });
  assert.deepEqual(result.details, { status: "passed" });
  assert.equal(received.projectName, "student");
  assert.equal(received.chatId, "chat-cli");
  assert.equal(received.taskId, "T-cli");
  assert.equal(received.command, undefined);
  assert.equal(received.args, undefined);
});

test("agent_cli 的 test action 只运行仓库测试，不接受任意进程参数", async () => {
  let received;
  const tool = createAgentCliTool({
    taskId: "T-cli",
    agentKey: "tester",
    execute: async (_action, input) => {
      received = input;
      return { status: "passed" };
    },
  });

  await tool.execute("call-test", { action: "test", command: "cmd.exe", args: ["/c", "whoami"] });
  assert.equal(received.command, process.execPath);
  assert.deepEqual(received.args, ["--test", "test"]);
});

test("agent_cli 对非法图表 JSON 返回可读的结构化失败", async () => {
  const tool = createAgentCliTool({
    taskId: "T-cli",
    getProjectName: () => "student",
    agentKey: "architect",
    execute: async () => ({ status: "passed" }),
  });

  const result = await tool.execute("call-2", { action: "render-diagram", diagramJson: "{" });
  assert.equal(result.details.status, "failed");
  assert.match(result.details.error, /diagramJson.*valid JSON/);
  assert.match(result.content[0].text, /valid JSON/);
});

test("agent_cli 只向机器人开放只读 bitable-check，不开放建表与写表动作", async () => {
  const calls = [];
  const tool = createAgentCliTool({
    taskId: "T-cli",
    getProjectName: () => "student",
    agentKey: "auditor",
    execute: async (action, input) => {
      calls.push({ action, input });
      return { status: "passed", action: "check" };
    },
  });

  const result = await tool.execute("call-bitable", { action: "bitable-check" });
  assert.deepEqual(result.details, { status: "passed", action: "check" });
  assert.equal(calls[0].action, "bitable-check");
  assert.equal(calls[0].input.projectName, "student");

  const denied = await tool.execute("call-bitable-setup", { action: "bitable" });
  assert.equal(denied.details.status, "failed");
  assert.match(denied.details.error, /unsupported agent CLI action/);
  assert.equal(calls.length, 1);
});
