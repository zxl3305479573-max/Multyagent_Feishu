import test from "node:test";
import assert from "node:assert/strict";
import { buildFailureCard, buildReply, buildResultCard, buildTextCard, sendCard } from "../src/gateway.js";

test("所有 Agent 的普通回复也使用卡片", () => {
  const card = buildTextCard({ text: "已完成检查" }, { displayName: "测试" });
  assert.equal(card.schema, "2.0");
  assert.ok(card.body.elements[0].text.content.includes("已完成检查"));
});

test("交付结果生成飞书卡片", () => {
  const card = buildResultCard({ delivery: { agentKey: "tester", summary: "测试通过", artifactPaths: ["test/report.md"], final: true } });
  assert.equal(card.schema, "2.0");
  assert.equal(card.header.template, "green");
  assert.ok(card.body.elements.some((element) => element.text.content.includes("test/report.md")));
});

test("失败结果生成红色错误卡片", () => {
  const card = buildFailureCard({ displayName: "测试" }, new Error("boom"), "T-001");
  assert.equal(card.header.template, "red");
  assert.ok(card.body.elements[0].text.content.includes("boom"));
});

test("sendCard 使用 interactive 消息类型", async () => {
  let payload;
  await sendCard({ im: { message: { create: async (value) => { payload = value; return { code: 0 }; } } } }, "chat-1", { schema: "2.0" });
  assert.equal(payload.data.msg_type, "interactive");
  assert.deepEqual(JSON.parse(payload.data.content), { schema: "2.0" });
});

test("sendCard converts action cards to legacy Feishu card shape", async () => {
  let payload;
  await sendCard({ im: { message: { create: async (value) => { payload = value; return { code: 0 }; } } } }, "chat-1", {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: "x" } },
    body: { elements: [{ tag: "action", actions: [] }] },
  });
  const card = JSON.parse(payload.data.content);
  assert.equal(card.schema, undefined);
  assert.equal(card.elements[0].tag, "action");
});

test("有交付包时只回结构化字段，丢弃自由文本", () => {
  const reply = buildReply({
    text: "这是一段很长的自由文本，包含思考过程和重复内容，不应该出现在飞书回帖里。",
    delivery: {
      agentKey: "backend_developer",
      summary: "实现了登录接口",
      artifactPaths: ["backend/src/auth.ts", "backend/src/user.ts"],
      next: "交测试验证",
      assumptions: ["令牌有效期暂定 2h"],
      final: false,
    },
  });
  assert.ok(reply.includes("交付完成"));
  assert.ok(reply.includes("backend_developer"));
  assert.ok(reply.includes("实现了登录接口"));
  assert.ok(reply.includes("backend/src/auth.ts"));
  assert.ok(reply.includes("交测试验证"));
  assert.ok(reply.includes("令牌有效期暂定 2h"));
  assert.ok(!reply.includes("很长的自由文本"), "不应包含 Agent 自由文本");
});

test("final 标记显示最终交付", () => {
  const reply = buildReply({ delivery: { agentKey: "project_manager", summary: "x", final: true } });
  assert.ok(reply.includes("最终交付"));
});

test("无交付包时清洗 Markdown 并截断", () => {
  assert.equal(buildReply({ text: "hello" }), "hello");
  assert.equal(buildReply({ text: "# 标题\n**粗体**\n- 项一" }), "标题\n粗体\n· 项一");
  const long = buildReply({ text: "x".repeat(2000) });
  assert.ok(long.length <= 410, `应截断到 maxLen，实际 ${long.length}`);
});

test("超长 summary 被截断", () => {
  const reply = buildReply({ delivery: { agentKey: "a", summary: "y".repeat(2000) } }, 400);
  assert.ok(reply.length < 1000);
  assert.ok(reply.includes("…"));
});

test("产物超过 8 个只列前 8 个", () => {
  const paths = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
  const reply = buildReply({ delivery: { agentKey: "a", summary: "s", artifactPaths: paths } });
  assert.ok(reply.includes("f0.ts"));
  assert.ok(reply.includes("f7.ts"));
  assert.ok(!reply.includes("f8.ts"));
});
