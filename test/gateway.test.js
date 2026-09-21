import test from "node:test";
import assert from "node:assert/strict";
import { createCardActionHandler, createDeduper, isApprovalCommand, parseControlCommand, parseMessage, parseNewTaskCommand } from "../src/gateway.js";

test("卡片确认反馈使用实际等待确认的 Agent 名称", async () => {
  let sentCard;
  const handler = createCardActionHandler({
    orchestrator: {
      resolveLatest: async () => ({ approved: true, agentName: "架构设计师" }),
    },
    client: {
      im: {
        message: {
          create: async (payload) => {
            sentCard = JSON.parse(payload.data.content);
            return { code: 0 };
          },
        },
      },
    },
  });

  await handler({
    context: { open_chat_id: "chat-1" },
    action: { value: { action: "approve", label: "确认执行" } },
  });

  assert.equal(sentCard.header.title.content, "架构设计师 回复");
  assert.ok(!sentCard.header.title.content.includes("项目经理"));
});

test("approval command requires an explicit confirmation phrase", () => {
  assert.equal(isApprovalCommand("确认执行"), true);
  assert.equal(isApprovalCommand("批准"), true);
  assert.equal(isApprovalCommand("你好，确认一下"), false);
});

test("parses SDK events wrapped under event.message", () => {
  const message = parseMessage({ event: { message: { message_id: "m2", chat_id: "c1", content: JSON.stringify({ text: "test" }) } } });
  assert.equal(message.text, "test");
});

test("parses text and removes the bot mention", () => {
  const message = parseMessage({ message: { message_id: "m1", chat_id: "c1", content: JSON.stringify({ text: '<at user_id="bot">项目经理</at> 测试连接' }) } });
  assert.equal(message.text, "测试连接");
  assert.equal(message.chatId, "c1");
});

test("rejects malformed or incomplete events", () => {
  assert.equal(parseMessage({ message: { message_id: "m1", chat_id: "c1", content: "bad" } }), null);
  assert.equal(parseMessage({ message: { message_id: "m1", content: "{}" } }), null);
  assert.equal(parseMessage({ message: { message_id: "m1", chat_id: "c1", content: JSON.stringify({ text: 42 }) } }), null);
});

test("deduplicates message IDs", () => {
  const accept = createDeduper(2);
  assert.equal(accept("m1"), true);
  assert.equal(accept("m1"), false);
  assert.equal(accept("m2"), true);
});

test("parseNewTaskCommand 识别新任务前缀并剥离", () => {
  assert.deepEqual(parseNewTaskCommand("新任务：做一个登录功能"), { isNewTask: true, text: "做一个登录功能" });
  assert.deepEqual(parseNewTaskCommand("新需求 做支付"), { isNewTask: true, text: "做支付" });
  assert.deepEqual(parseNewTaskCommand("new task: build login"), { isNewTask: true, text: "build login" });
});

test("parseNewTaskCommand 普通消息不误判", () => {
  assert.deepEqual(parseNewTaskCommand("继续之前的登录"), { isNewTask: false, text: "继续之前的登录" });
  assert.deepEqual(parseNewTaskCommand("这个新需求点不错"), { isNewTask: false, text: "这个新需求点不错" });
});

test("deduper.release 允许失败后重试", () => {
  const accept = createDeduper();
  assert.equal(accept("m1"), true);
  assert.equal(accept("m1"), false);
  accept.release("m1");
  assert.equal(accept("m1"), true, "释放后同一消息应可再次处理");
});

test("parseControlCommand 识别暂停/恢复，不误判", () => {
  assert.equal(parseControlCommand("暂停"), "pause");
  assert.equal(parseControlCommand("停止。"), "pause");
  assert.equal(parseControlCommand("恢复"), "resume");
  assert.equal(parseControlCommand("继续执行"), "resume");
  assert.equal(parseControlCommand("继续之前的工作"), null);
  assert.equal(parseControlCommand("暂停后请告诉我"), null);
});
