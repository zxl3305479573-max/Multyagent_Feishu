import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResultCard, createCardActionHandler, createDeduper, createRoleHandler, isApprovalCommand, isStatusQueryCommand, loadProjectSummaryFor, parseControlCommand, parseMessage, parseNewTaskCommand, shouldHandleMessage } from "../src/gateway.js";
import { appendProjectSummary } from "../src/project-summary.js";
import { _resetForTest, createTask, findTaskByRoot, updateTask } from "../src/tasks.js";

const BOT_NAMES = ["项目经理", "架构设计师", "前端开发", "后端开发", "测试", "审计"];

function groupMessage(mentions = []) {
  return { chatType: "group", mentions };
}

test("群聊没 @ 任何人时只有项目经理处理", () => {
  const options = { agentKey: "project_manager", displayName: "项目经理", selfOpenId: "ou_pm", botNames: BOT_NAMES };
  assert.equal(shouldHandleMessage(groupMessage(), options), true);
  assert.equal(
    shouldHandleMessage(groupMessage(), { ...options, agentKey: "architect", displayName: "架构设计师", selfOpenId: "ou_ar" }),
    false,
  );
});

test("群聊 @ 了某个机器人时只由它处理", () => {
  const mentions = [{ openId: "ou_ar", name: "架构设计师" }];
  assert.equal(
    shouldHandleMessage(groupMessage(mentions), { agentKey: "architect", displayName: "架构设计师", selfOpenId: "ou_ar", botNames: BOT_NAMES }),
    true,
  );
  assert.equal(
    shouldHandleMessage(groupMessage(mentions), { agentKey: "project_manager", displayName: "项目经理", selfOpenId: "ou_pm", botNames: BOT_NAMES }),
    false,
  );
});

test("群聊 @ 的是人而不是机器人时，仍交给项目经理", () => {
  const mentions = [{ openId: "ou_human", name: "张三" }];
  assert.equal(
    shouldHandleMessage(groupMessage(mentions), { agentKey: "project_manager", displayName: "项目经理", selfOpenId: "ou_pm", botNames: BOT_NAMES }),
    true,
  );
  assert.equal(
    shouldHandleMessage(groupMessage(mentions), { agentKey: "tester", displayName: "测试", selfOpenId: "ou_te", botNames: BOT_NAMES }),
    false,
  );
});

test("@ 里的名字是飞书应用名时同样能识别自己", () => {
  // 飞书里机器人叫「MultyAgent-架构设计师」，与配置的显示名不同
  const options = {
    agentKey: "architect",
    displayName: "架构设计师",
    selfName: "MultyAgent-架构设计师",
    selfOpenId: "ou_ar",
    botNames: [...BOT_NAMES, "MultyAgent-架构设计师"],
  };
  assert.equal(shouldHandleMessage(groupMessage([{ openId: "ou_ar", name: "MultyAgent-架构设计师" }]), options), true);
  assert.equal(
    shouldHandleMessage(groupMessage([{ openId: "ou_ar", name: "MultyAgent-架构设计师" }]), { ...options, agentKey: "project_manager", displayName: "项目经理", selfName: "MultyAgent-项目经理", selfOpenId: "ou_pm" }),
    false,
  );
});

test("单聊任何角色都处理，且没有 chat_type 时按单聊对待", () => {
  for (const key of ["project_manager", "architect", "tester"]) {
    assert.equal(shouldHandleMessage({ chatType: "p2p" }, { agentKey: key }), true);
    assert.equal(shouldHandleMessage({}, { agentKey: key }), true);
  }
});

test("机器人自己/其他机器人发的群消息不能被当成新任务", async () => {
  _resetForTest("runtime/tasks.gateway.test.json");
  try {
    const runs = [];
    const handler = createRoleHandler({
      agent: { key: "project_manager", displayName: "项目经理", appId: "x" },
      client: { im: { message: { create: async () => ({ code: 0 }) } } },
      runAgent: async (agent, text) => {
        runs.push(text);
        return { text: "ok", delivery: null, projectName: null };
      },
      botNames: BOT_NAMES,
      selfOpenId: "ou_pm",
      log: { info() {}, error() {}, warn() {} },
    });

    // 机器人（比如本网关刚发的卡片回执）发的消息
    await handler({
      sender: { sender_type: "app" },
      message: {
        message_id: "m-from-bot",
        chat_id: "c1",
        chat_type: "group",
        content: JSON.stringify({ text: "已接收任务" }),
      },
    });
    assert.deepEqual(runs, [], "机器人消息不得触发执行，否则会自激循环");

    // 同一群里的真人消息才该执行
    await handler({
      sender: { sender_type: "user" },
      message: {
        message_id: "m-from-user",
        chat_id: "c1",
        chat_type: "group",
        content: JSON.stringify({ text: "帮我做个学生管理系统" }),
      },
    });
    assert.deepEqual(runs, ["帮我做个学生管理系统"]);
  } finally {
    rmSync("runtime/tasks.gateway.test.json", { force: true });
    _resetForTest();
  }
});

test("makeHandler 之前的形态：群聊无 @ 时架构师不触发 runAgent", async () => {
  _resetForTest("runtime/tasks.gateway.test.json");
  try {
    const runs = [];
    const handler = createRoleHandler({
      agent: { key: "architect", displayName: "架构设计师", appId: "x" },
      client: { im: { message: { create: async () => ({ code: 0 }) } } },
      runAgent: async (agent) => {
        runs.push(agent.key);
        return { text: "ok", delivery: null, projectName: null };
      },
      botNames: BOT_NAMES,
      selfOpenId: "ou_ar",
      log: { info() {}, error() {}, warn() {} },
    });

    await handler({
      message: {
        message_id: "m-group-1",
        chat_id: "c1",
        chat_type: "group",
        content: JSON.stringify({ text: "帮我做个学生管理系统" }),
      },
    });
    assert.deepEqual(runs, [], "群里没人 @ 架构师时不该抢活");

    await handler({
      message: {
        message_id: "m-group-2",
        chat_id: "c1",
        chat_type: "group",
        mentions: [{ key: "@_user_1", id: { open_id: "ou_ar" }, name: "架构设计师" }],
        content: JSON.stringify({ text: '<at user_id="ou_ar">架构设计师</at> 出个架构方案' }),
      },
    });
    assert.deepEqual(runs, ["architect"], "@ 了架构师时应由它执行");
  } finally {
    rmSync("runtime/tasks.gateway.test.json", { force: true });
    _resetForTest();
  }
});

test("createRoleHandler 传入任务记录里的项目名，并回写交付里的项目名", async () => {
  _resetForTest("runtime/tasks.gateway.test.json");
  try {
    const task = await createTask({ agentKey: "project_manager", chatId: "c1", rootKey: "r1", messageId: "m1" });
    await updateTask(task.taskId, { projectName: "student" });

    const seen = [];
    const handler = createRoleHandler({
      agent: { key: "project_manager", displayName: "项目经理", appId: "x" },
      client: { im: { message: { create: async () => ({ code: 0 }) } } },
      runAgent: async (agent, text, context) => {
        seen.push({ text, context });
        return {
          text: "ok",
          delivery: { agentKey: agent.key, summary: "ok", artifactPaths: [], final: true },
          projectName: "teacher",
        };
      },
      log: { info() {}, error() {}, warn() {} },
    });

    await handler({
      message: { message_id: "m2", chat_id: "c1", root_id: "r1", content: JSON.stringify({ text: "继续" }) },
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].context.projectName, "student", "应把任务记录里的项目名传给 Agent");
    const stored = await findTaskByRoot("project_manager", "r1");
    assert.equal(stored.projectName, "teacher", "交付里的项目名应回写到任务记录");
  } finally {
    rmSync("runtime/tasks.gateway.test.json", { force: true });
    _resetForTest();
  }
});

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

test("状态查询意图只匹配明确的状态或进度询问", () => {
  assert.equal(isStatusQueryCommand("查询当前任务状态"), true);
  assert.equal(isStatusQueryCommand("现在进展如何？"), true);
  assert.equal(isStatusQueryCommand("status"), true);
  assert.equal(isStatusQueryCommand("帮我实现状态管理"), false);
});

test("状态查询复用超出普通会话 TTL 的最近根任务，且不创建或启动新任务", async () => {
  _resetForTest("runtime/tasks.gateway.status.test.json");
  try {
    const task = await createTask({ agentKey: "project_manager", chatId: "c-status", rootKey: "root-status", messageId: "m-old" });
    const events = [];
    const runs = [];
    const completed = [];
    const handler = createRoleHandler({
      agent: { key: "project_manager", displayName: "项目经理", appId: "x" },
      client: { im: { message: { create: async () => ({ code: 0 }) } } },
      runAgent: async (agent, text, context) => { runs.push({ agent, text, context }); return { text: "不应启动" }; },
      getTaskStatus: async (taskId, chatId) => ({ task_id: taskId, status: "in_progress", active_agents: ["project_manager"], latest_event: "task_started", chat_id: chatId }),
      orchestrator: { onTaskCompleted: async (...args) => completed.push(args) },
      onEvent: async (event) => events.push(event),
      log: { info() {}, error() {}, warn() {} },
    });

    await handler({
      message: {
        message_id: "m-status",
        chat_id: "c-status",
        chat_type: "group",
        content: JSON.stringify({ text: "查询当前任务状态" }),
      },
    });

    assert.equal(runs.length, 0);
    assert.equal(completed.length, 0);
    assert.equal(events.some((event) => event.type === "task_created"), false);
    assert.equal(events.some((event) => event.type === "task_started"), false);
    assert.equal(events.some((event) => event.type === "task_completed"), false);
  } finally {
    rmSync("runtime/tasks.gateway.status.test.json", { force: true });
    _resetForTest();
  }
});

test("状态查询走只读快照，不启动新的 Agent 会话", async () => {
  _resetForTest("runtime/tasks.gateway.status.snapshot.test.json");
  try {
    await createTask({ agentKey: "project_manager", chatId: "c-snapshot", rootKey: "root-snapshot", messageId: "m-old" });
    const runs = [];
    const sent = [];
    const handler = createRoleHandler({
      agent: { key: "project_manager", displayName: "项目经理", appId: "x" },
      client: { im: { message: { create: async (payload) => { sent.push(JSON.parse(payload.data.content)); return { code: 0 }; } } } },
      runAgent: async (...args) => { runs.push(args); return { text: "不应启动" }; },
      getTaskStatus: async (taskId, chatId) => ({ task_id: taskId, status: "in_progress", active_agents: ["project_manager"], latest_event: "task_started", chat_id: chatId }),
      log: { info() {}, error() {}, warn() {} },
    });

    await handler({ message: { message_id: "m-status", chat_id: "c-snapshot", content: JSON.stringify({ text: "查询当前任务状态" }) } });

    assert.equal(runs.length, 0);
    assert.match(JSON.stringify(sent), /in_progress/);
  } finally {
    rmSync("runtime/tasks.gateway.status.snapshot.test.json", { force: true });
    _resetForTest();
  }
});

test("approval card carries the task id for precise callback resolution", () => {
  const card = buildResultCard({ taskId: "task-42", delivery: { agentKey: "architect", agentName: "架构设计师", summary: "方案完成", next: "确认后继续执行", choices: [{ id: "approve", label: "确认执行" }], final: false } });
  const action = card.body.elements.find((element) => element.tag === "action");
  assert.equal(action.actions[0].value.task_id, "task-42");
});

test("approval card omits task_id when no task id is available", () => {
  const card = buildResultCard({ delivery: { agentKey: "architect", agentName: "架构设计师", summary: "方案完成", next: "确认后继续执行", choices: [{ id: "approve", label: "确认执行" }], final: false } });
  const action = card.body.elements.find((element) => element.tag === "action");
  assert.equal(Object.hasOwn(action.actions[0].value, "task_id"), false);
});

test("card callback forwards task_id as the third resolveLatest argument", async () => {
  const calls = [];
  const handler = createCardActionHandler({
    orchestrator: { resolveLatest: async (...args) => { calls.push(args); return { agentName: "架构设计师" }; } },
    client: { im: { message: { create: async () => ({ code: 0 }) } } },
  });
  await handler({ context: { open_chat_id: "chat-1" }, action: { value: { action: "approve", choice: "approve", task_id: "task-42" } } });
  assert.deepEqual(calls, [["chat-1", "approve", "task-42"]]);
});

test("result card renders execution evidence", () => {
  const card = buildResultCard({
    taskId: "task-43",
    delivery: {
      agentKey: "tester",
      agentName: "测试",
      summary: "登录功能已验证",
      artifactPaths: ["reports/login.md"],
      evidence: [{ command: "npm test", result: "passed", details: "32 passed" }],
      commit: "abc1234",
      durationMs: 8120,
      final: true,
    },
  });
  const text = JSON.stringify(card);
  assert.match(text, /npm test/);
  assert.match(text, /32 passed/);
  assert.match(text, /abc1234/);
  assert.match(text, /8\.1/);
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

test("根 Agent 收到 Trace 回调，取消结果不作为普通失败处理", async () => {
  _resetForTest("runtime/tasks.gateway.cancel.test.json");
  try {
    const events = [];
    let receivedContext;
    const handler = createRoleHandler({
      agent: { key: "project_manager", displayName: "项目经理", appId: "x" },
      client: { im: { message: { create: async () => ({ code: 0 }) } } },
      runAgent: async (_agent, _text, context) => {
        receivedContext = context;
        return { cancelled: true, text: "", delivery: null, projectName: null };
      },
      onEvent: async (event) => events.push(event),
      log: { info() {}, error() {}, warn() {} },
    });
    await handler({
      sender: { sender_type: "user" },
      message: { message_id: "m-cancel", chat_id: "c-cancel", chat_type: "p2p", content: JSON.stringify({ text: "开始长任务" }) },
    });
    assert.equal(typeof receivedContext.onEvent, "function");
    assert.ok(events.some((event) => event.type === "task_cancelled"));
    assert.equal(events.some((event) => event.type === "task_failed"), false);
  } finally {
    rmSync("runtime/tasks.gateway.cancel.test.json", { force: true });
    _resetForTest();
  }
});

test("loadProjectSummaryFor 只给项目经理注入项目历史摘要", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-summary-"));
  try {
    await appendProjectSummary({
      root,
      projectName: "student",
      taskId: "T-1",
      agentKey: "architect",
      agentName: "架构设计师",
      delivery: { summary: "架构已定", artifactPaths: [] },
    });
    const pm = await loadProjectSummaryFor("project_manager", "student", { root });
    assert.match(pm.content, /架构已定/);
    assert.equal(await loadProjectSummaryFor("tester", "student", { root }), null);
    assert.equal(await loadProjectSummaryFor("project_manager", "missing", { root }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
