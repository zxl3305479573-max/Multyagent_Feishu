import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, buildSystemPrompt, extractText } from "../src/pi-agent.js";

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
