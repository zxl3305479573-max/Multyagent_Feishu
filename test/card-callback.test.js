// 卡片回调端到端：飞书要求回调尽快应答，因此回调只做「认领 + 回执」，
// 可能跑完整轮 Agent 的推进放后台，用 orchestrator.whenIdle() 等待收尾。
import test from "node:test";
import assert from "node:assert/strict";
import { createCardActionHandler } from "../src/gateway.js";
import { createOrchestrator } from "../src/orchestrator.js";

const ROLES = ["project_manager", "architect", "frontend_developer", "backend_developer", "tester", "auditor"];

function makeClient() {
  const sent = [];
  return {
    sent,
    im: { message: { create: async (payload) => { sent.push(payload); return { code: 0, data: { message_id: "m1" } }; } } },
  };
}

function makeLog() {
  const errors = [];
  return { errors, info() {}, warn() {}, error(message) { errors.push(String(message)); } };
}

function makeOrchestrator(runAgent) {
  const dispatched = [];
  const prompts = [];
  const runner = runAgent || (async (agent, prompt) => {
    dispatched.push(agent.key);
    prompts.push(prompt);
    return {
      text: "done",
      delivery: { agentKey: agent.key, summary: "done", artifactPaths: [], artifactsDir: "d", final: true },
      projectName: null,
    };
  });
  const client = makeClient();
  const orchestrator = createOrchestrator({ runAgent: runner, log: makeLog() });
  for (const key of ROLES) orchestrator.registerRole({ key, displayName: key, appId: "app" }, client);
  return { orchestrator, client, dispatched, prompts };
}

// 制造一张带选项的提问卡（项目经理自己需要用户澄清）。
async function primeQuestion(orchestrator, { taskId = "T-ask", chatId = "chat-1" } = {}) {
  await orchestrator.onTaskCompleted("project_manager", taskId, {
    delivery: {
      agentKey: "project_manager",
      agentName: "project_manager",
      summary: "需求待澄清",
      artifactPaths: [],
      artifactsDir: "d",
      choices: [
        { id: "typical", label: "按典型方案起步" },
        { id: "detail", label: "我先补充细节" },
      ],
      assignments: [],
    },
    context: { chatId, requireHumanApproval: true },
  });
}

// 制造一张带派发清单的确认卡。
async function primeDispatch(orchestrator, { taskId = "T-dispatch", chatId = "chat-1" } = {}) {
  await orchestrator.onTaskCompleted("project_manager", taskId, {
    delivery: {
      agentKey: "project_manager",
      agentName: "project_manager",
      summary: "计划就绪",
      artifactPaths: [],
      artifactsDir: "d",
      assignments: [{ agentKey: "architect", task: "产出接口契约" }],
    },
    context: { chatId, requireHumanApproval: true },
  });
}

function cards(client) {
  return client.sent.map((payload) => JSON.parse(payload.data.content));
}

function cardContaining(client, text) {
  return cards(client).find((card) => JSON.stringify(card).includes(text));
}

test("提问卡点击：回调不等 Agent 跑完就返回，选择随后交回原角色", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let finished = false;
  const { orchestrator, client, prompts } = makeOrchestrator(async (agent, prompt) => {
    prompts.push(prompt);
    await gate;
    finished = true;
    return {
      text: "继续",
      delivery: { agentKey: agent.key, summary: "已推进", artifactPaths: [], artifactsDir: "d", final: true },
      projectName: null,
    };
  });
  await primeQuestion(orchestrator);

  const handler = createCardActionHandler({ orchestrator, client, log: makeLog() });
  const response = await handler({ chatId: "chat-1", action: { value: { action: "choice", choice: "typical" } } });

  assert.equal(response.toast.type, "success");
  assert.equal(finished, false, "回调不能等到 Agent 跑完，否则飞书会超时");
  assert.ok(cardContaining(client, "已确认，正在继续执行"), "回调应立即给可见回执");

  release();
  await orchestrator.whenIdle();
  assert.equal(finished, true, "后台推进最终要跑完");
  assert.match(prompts[0], /typical/);
});

test("派发卡点击：回调立即回执，后台才放行下游", async () => {
  const { orchestrator, client, dispatched } = makeOrchestrator();
  await primeDispatch(orchestrator);

  const handler = createCardActionHandler({ orchestrator, client, log: makeLog() });
  const response = await handler({ chatId: "chat-1", action: { value: { action: "approve", choice: "approve" } } });

  assert.equal(response.toast.type, "success");
  assert.ok(cardContaining(client, "已确认，正在继续执行"));
  await orchestrator.whenIdle();
  assert.deepEqual(dispatched, ["architect"], "确认后应派发下游");
});

test("连点两次：第二次提示没有等待任务，且不重复派发", async () => {
  const { orchestrator, client, dispatched } = makeOrchestrator();
  await primeDispatch(orchestrator);

  const handler = createCardActionHandler({ orchestrator, client, log: makeLog() });
  const event = { chatId: "chat-1", action: { value: { action: "approve", choice: "approve" } } };
  const first = await handler(event);
  const second = await handler(event);

  assert.equal(first.toast.type, "success");
  assert.equal(second.toast.type, "warning");
  assert.ok(cardContaining(client, "当前没有等待选择的任务"));
  await orchestrator.whenIdle();
  assert.deepEqual(dispatched, ["architect"], "第二次点击不应重复派发");
});

test("卡片回调把 task_id 传给编排器，避免误确认同群其他任务", async () => {
  const calls = [];
  const handler = createCardActionHandler({
    client: makeClient(),
    agent: { key: "architect", displayName: "架构设计师" },
    orchestrator: { resolveLatest: async (...args) => { calls.push(args); return { taskId: "task-42", agentName: "架构设计师" }; } },
  });
  await handler({ chatId: "chat-1", action: { value: { action: "approve", task_id: "task-42" } } });
  assert.deepEqual(calls[0], ["chat-1", "approve", "task-42"]);
});

test("没有待确认项时点击：提示无等待任务且不派发", async () => {
  const { orchestrator, client, dispatched } = makeOrchestrator();
  const handler = createCardActionHandler({ orchestrator, client, log: makeLog() });

  const response = await handler({ chatId: "chat-empty", action: { value: { action: "approve" } } });

  assert.equal(response.toast.type, "warning");
  assert.equal(client.sent.length, 1);
  assert.ok(cardContaining(client, "当前没有等待选择的任务"));
  await orchestrator.whenIdle();
  assert.deepEqual(dispatched, []);
});

test("跨会话点击不误恢复别的群待确认项", async () => {
  const { orchestrator, client, dispatched } = makeOrchestrator();
  await primeDispatch(orchestrator, { chatId: "chat-A" });

  const handler = createCardActionHandler({ orchestrator, client, log: makeLog() });
  const response = await handler({ chatId: "chat-B", action: { value: { action: "approve" } } });

  assert.equal(response.toast.type, "warning");
  await orchestrator.whenIdle();
  assert.deepEqual(dispatched, [], "不得跨群放行");
});

test("非白名单 action：不派发、不发卡", async () => {
  const { orchestrator, client, dispatched } = makeOrchestrator();
  await primeDispatch(orchestrator);

  const handler = createCardActionHandler({ orchestrator, client, log: makeLog() });
  for (const value of [{ action: "delete" }, {}, undefined]) {
    const response = await handler({ chatId: "chat-1", action: { value } });
    assert.equal(response.toast.type, "warning");
  }

  await orchestrator.whenIdle();
  assert.deepEqual(dispatched, []);
  assert.equal(client.sent.length, 0);
});

test("SDK 规范化事件（顶层 chatId）同样能命中待确认项", async () => {
  const { orchestrator, client, prompts } = makeOrchestrator();
  await primeQuestion(orchestrator, { chatId: "chat-normalized" });

  const handler = createCardActionHandler({ orchestrator, client, log: makeLog() });
  const response = await handler({
    messageId: "om_card_1",
    chatId: "chat-normalized",
    action: { value: JSON.stringify({ action: "choice", choice: "detail" }) },
    operator: { openId: "ou_user_1" },
  });

  assert.equal(response.toast.type, "success");
  await orchestrator.whenIdle();
  assert.match(prompts[0], /detail/);
});

test("卡片回调记录接收与解析结果，便于按任务追踪", async () => {
  const { orchestrator, client } = makeOrchestrator();
  await primeDispatch(orchestrator, { taskId: "T-observe", chatId: "chat-observe" });
  const events = [];
  const handler = createCardActionHandler({
    orchestrator,
    client,
    log: makeLog(),
    agent: { key: "project_manager" },
    onEvent: async (event) => events.push(event),
  });

  await handler({ chatId: "chat-observe", messageId: "card-message-1", action: { value: { action: "approve" } } });

  assert.equal(events[0].type, "card_action_received");
  assert.equal(events[0].chat_id, "chat-observe");
  assert.equal(events[1].type, "card_action_resolved");
  assert.equal(events[1].task_id, "T-observe");
  assert.equal(events[1].resolved, true);
  await orchestrator.whenIdle();
});
