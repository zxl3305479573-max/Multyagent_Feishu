import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIRM_ROLES,
  buildResultCard,
  createCardActionHandler,
  isApprovalCommand,
  parseConfirmRoles,
  uploadCardImage,
} from "../src/gateway.js";

const ALL_ROLES = ["project_manager", "architect", "frontend_developer", "backend_developer", "tester", "auditor"];

function actionElement(card) {
  return card.body.elements.find((element) => element?.tag === "action");
}

function buttonLabels(card) {
  return (actionElement(card)?.actions || []).map((action) => action.text.content);
}

function deliveryOf(agentKey, extra = {}) {
  return { agentKey, agentName: agentKey, summary: "阶段结果", artifactPaths: ["workspace/x/out.md"], ...extra };
}

function fakeEnv(raw) {
  const original = process.env.PI_CONFIRM_ROLES;
  if (raw === undefined) delete process.env.PI_CONFIRM_ROLES;
  else process.env.PI_CONFIRM_ROLES = raw;
  return () => {
    if (original === undefined) delete process.env.PI_CONFIRM_ROLES;
    else process.env.PI_CONFIRM_ROLES = original;
  };
}

function makeHandler({ resolveLatest, sent = [], log = { error() {} } } = {}) {
  const calls = [];
  const handler = createCardActionHandler({
    orchestrator: {
      resolveLatest: resolveLatest || (async (chatId, selection) => {
        calls.push({ chatId, selection });
        return { approved: true, agentKey: "architect", agentName: "架构设计师", selection };
      }),
    },
    client: { im: { message: { create: async (payload) => { sent.push(JSON.parse(payload.data.content)); return { code: 0 }; } } } },
    log,
  });
  return { handler, calls };
}

// ---------------------------------------------------------------------------
// T1：六角色各自出确认按钮
// ---------------------------------------------------------------------------

test("默认配置下六个角色的交付卡片都带「确认执行」按钮", () => {
  const restore = fakeEnv(undefined);
  try {
    for (const agentKey of ALL_ROLES) {
      const card = buildResultCard({ delivery: deliveryOf(agentKey) });
      const action = actionElement(card);
      assert.ok(action, `${agentKey} 应渲染 action 元素`);
      assert.deepEqual(buttonLabels(card), ["确认执行"], `${agentKey} 按钮文案`);
      assert.equal(action.actions[0].type, "primary");
      assert.deepEqual(action.actions[0].value, { action: "approve", choice: "approve", label: "确认执行" });
      assert.match(card.header.title.content, /^请确认下一步/);
      assert.match(card.body.elements[0].text.content, /请确认后继续执行/);
    }
  } finally {
    restore();
  }
});

test("默认确认角色集合就是六个角色", () => {
  assert.deepEqual(DEFAULT_CONFIRM_ROLES.split(","), ALL_ROLES);
  assert.deepEqual([...parseConfirmRoles(undefined)].sort(), [...ALL_ROLES].sort());
});

test("六角色逐个断言：按钮 value 可被 handler 白名单接受", async () => {
  const restore = fakeEnv(undefined);
  try {
    for (const agentKey of ALL_ROLES) {
      const card = buildResultCard({ delivery: deliveryOf(agentKey) });
      const value = actionElement(card).actions[0].value;
      const { handler, calls } = makeHandler({ resolveLatest: async (chatId, selection) => { calls.push({ chatId, selection }); return { approved: true, agentKey }; } });
      const response = await handler({ context: { open_chat_id: "c1" }, action: { value } });
      assert.equal(response.toast.type, "success", `${agentKey} 点击应有成功反馈`);
      assert.deepEqual(calls, [{ chatId: "c1", selection: "approve" }], `${agentKey} 应触发 resolveLatest`);
    }
  } finally {
    restore();
  }
});

test("PI_CONFIRM_ROLES 白名单外的角色不出按钮", () => {
  const restore = fakeEnv("project_manager,architect");
  try {
    for (const agentKey of ["frontend_developer", "backend_developer", "tester", "auditor"]) {
      const card = buildResultCard({ delivery: deliveryOf(agentKey) });
      assert.equal(actionElement(card), undefined, `${agentKey} 不应出按钮`);
      assert.equal(card.header.title.content.startsWith("阶段完成"), true);
    }
    for (const agentKey of ["project_manager", "architect"]) {
      assert.ok(actionElement(buildResultCard({ delivery: deliveryOf(agentKey) })), `${agentKey} 仍应出按钮`);
    }
  } finally {
    restore();
  }
});

test("PI_CONFIRM_ROLES=project_manager 即方案 B：只有项目经理出按钮", () => {
  const restore = fakeEnv("project_manager");
  try {
    assert.ok(actionElement(buildResultCard({ delivery: deliveryOf("project_manager") })));
    for (const agentKey of ALL_ROLES.filter((key) => key !== "project_manager")) {
      assert.equal(actionElement(buildResultCard({ delivery: deliveryOf(agentKey) })), undefined, `${agentKey} 在方案 B 下不出按钮`);
    }
  } finally {
    restore();
  }
});

test("PI_CONFIRM_ROLES 容错：空白/多余逗号/空格不影响解析（一行回退可用）", () => {
  const restore = fakeEnv("  project_manager , architect ,, ");
  try {
    const roles = parseConfirmRoles();
    assert.deepEqual([...roles].sort(), ["architect", "project_manager"]);
  } finally {
    restore();
  }
});

test("PI_CONFIRM_ROLES 显式传空字符串时应回退默认集合，而不是关闭全部确认", () => {
  const restore = fakeEnv("   ");
  try {
    assert.deepEqual([...parseConfirmRoles()].sort(), [...ALL_ROLES].sort());
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// T1：约束不回归
// ---------------------------------------------------------------------------

test("final:true 的交付不出按钮（六角色逐个断言）", () => {
  const restore = fakeEnv(undefined);
  try {
    for (const agentKey of ALL_ROLES) {
      const card = buildResultCard({ delivery: deliveryOf(agentKey, { final: true }) });
      assert.equal(actionElement(card), undefined, `${agentKey} final 交付不应出按钮`);
      assert.equal(card.header.template, "green");
      assert.match(card.header.title.content, /^最终交付/);
      assert.ok(!card.body.elements[0].text.content.includes("请确认后继续执行"));
    }
  } finally {
    restore();
  }
});

test("agentKey 为空时不出按钮（无法判断归属）", () => {
  const card = buildResultCard({ delivery: { summary: "无归属交付" } });
  assert.equal(actionElement(card), undefined);
});

test("交付卡带 diagramImageKey 时渲染图片元素，不带时不渲染", () => {
  const withDiagram = buildResultCard({
    delivery: deliveryOf("architect"),
    diagramImageKey: "img_v2_abc",
  });
  const img = withDiagram.body.elements.find((element) => element?.tag === "img");
  assert.ok(img, "应渲染 img 元素");
  assert.equal(img.img_key, "img_v2_abc");
  assert.equal(img.alt.content, "系统架构流程图");

  // 图片必须排在正文之后、按钮之前，阅读顺序才对
  const order = withDiagram.body.elements.map((element) => element.tag);
  assert.deepEqual(order, ["div", "img", "action"]);

  const without = buildResultCard({ delivery: deliveryOf("architect") });
  assert.equal(without.body.elements.some((element) => element?.tag === "img"), false);
});

test("uploadCardImage 返回飞书给的 image_key", async () => {
  const calls = [];
  const client = {
    im: { image: { create: async (payload) => { calls.push(payload); return { data: { image_key: "img_v2_xyz" } }; } } },
  };
  const key = await uploadCardImage(client, Buffer.from("png-bytes"));
  assert.equal(key, "img_v2_xyz");
  assert.equal(calls[0].data.image_type, "message");
  assert.ok(Buffer.isBuffer(calls[0].data.image));

  // 飞书实际返回的是顶层 image_key（已实测），两种形态都要认
  const flat = { im: { image: { create: async () => ({ image_key: "img_flat" }) } } };
  assert.equal(await uploadCardImage(flat, Buffer.from("x")), "img_flat");
});

test("交付带 diagram 时渲染成图并嵌进卡片，上传失败则降级为纯文本卡", async () => {
  const { sendResultCard } = await import("../src/gateway.js");
  const diagram = {
    title: "架构",
    nodes: [{ id: "a", label: "客户端" }, { id: "b", label: "服务端" }],
    edges: [{ from: "a", to: "b", label: "REST" }],
  };
  const delivery = { agentKey: "architect", agentName: "架构设计师", summary: "架构已完成", artifactPaths: [], diagram };
  const elementsOf = (payload) => JSON.parse(payload.data.content).elements ?? JSON.parse(payload.data.content).body.elements;

  const sent = [];
  const okClient = {
    im: {
      image: { create: async () => ({ data: { image_key: "img_v2_test" } }) },
      message: { create: async (payload) => { sent.push(payload); return { code: 0 }; } },
    },
  };
  await sendResultCard(okClient, "chat-1", { delivery }, { log: { error() {} } });
  const img = elementsOf(sent[0]).find((element) => element.tag === "img");
  assert.ok(img, "应把渲染出来的图放进卡片");
  assert.equal(img.img_key, "img_v2_test");
  assert.equal(img.alt.content, "系统架构流程图");

  const errors = [];
  const failingClient = {
    im: {
      image: { create: async () => { throw new Error("no scope"); } },
      message: { create: async (payload) => { sent.push(payload); return { code: 0 }; } },
    },
  };
  await sendResultCard(failingClient, "chat-1", { delivery }, { log: { error: (message) => errors.push(message) } });
  assert.equal(elementsOf(sent[1]).some((element) => element.tag === "img"), false, "上传失败不应嵌图");
  assert.equal(errors.length, 1, "上传失败要记录日志");

  const plain = [];
  await sendResultCard(okClient, "chat-1", { delivery: { ...delivery, diagram: null } }, { log: { error: (message) => plain.push(message) } });
  assert.equal(elementsOf(sent[2]).some((element) => element.tag === "img"), false);
  assert.equal(plain.length, 0);
});

test("卡片正文把 Markdown 标题降级为加粗、去掉反引号，不再字面显示 ##", () => {
  const card = buildResultCard({
    delivery: {
      agentKey: "project_manager",
      summary: "## 结论\n\nteacher 已暂停。\n\n## 关键决策\n\n1. 即时冻结：`workspace/teacher/` 不再新增文件\n- 第二条\n\n---\n\n### 产物内容要点",
    },
  });
  const content = card.body.elements[0].text.content;
  assert.equal(content.includes("##"), false, "标题井号不应字面出现");
  assert.equal(content.includes("`"), false, "反引号不应字面出现");
  assert.ok(content.includes("**结论**"), "标题应降级为加粗");
  assert.ok(content.includes("**关键决策**"));
  assert.ok(content.includes("workspace/teacher/ 不再新增文件"), "反引号要去掉但内容保留");
  assert.ok(content.includes("· 第二条"), "连字符列表统一成 ·");
  assert.equal(content.includes("---"), false, "分隔线应去掉");
});

test("卡片正文清掉代码围栏、引用符号、表格线与斜体星号，只留加粗标题", () => {
  const card = buildResultCard({
    delivery: {
      agentKey: "architect",
      summary: [
        "## 接口清单",
        "",
        "| 端点 | 方法 |",
        "| --- | --- |",
        "| /students | GET |",
        "",
        "> 注意：分页从 1 开始",
        "",
        "```bash",
        "npm run dev",
        "```",
        "",
        "*斜体说明* 还有 * 号在中间：2 * 3",
      ].join("\n"),
    },
  });
  const content = card.body.elements[0].text.content;
  assert.ok(content.includes("**接口清单**"), "标题保持加粗");
  assert.equal(content.includes("```"), false, "代码围栏应去掉");
  assert.ok(content.includes("npm run dev"), "围栏内内容按普通文本保留");
  assert.equal(content.includes("|"), false, "表格竖线应去掉");
  assert.ok(content.includes("端点 · 方法"), "表头拍平成一行");
  assert.ok(content.includes("注意：分页从 1 开始"), "引用内容保留、符号去掉");
  assert.equal(content.trimStart().startsWith(">"), false, "引用符号应去掉");
  assert.equal(/^\s/.test(content.split("\n").find((line) => line.includes("注意"))), false, "引用行不应残留行首空格");
  assert.ok(content.includes("斜体说明"), "斜体内容保留");
  assert.ok(content.includes("2 * 3"), "行内乘号不该被当成斜体");
});

test("项目经理即使填了 diagram 也不渲染架构图，只有架构师可以", async () => {
  const { sendResultCard } = await import("../src/gateway.js");
  const diagram = { nodes: [{ id: "a", label: "客户端" }, { id: "b", label: "服务端" }], edges: [{ from: "a", to: "b" }] };
  const sent = [];
  let uploads = 0;
  const client = {
    im: {
      image: { create: async () => { uploads += 1; return { image_key: "img_v2_x" }; } },
      message: { create: async (payload) => { sent.push(payload); return { code: 0 }; } },
    },
  };
  const elementsOf = (payload) => JSON.parse(payload.data.content).elements ?? JSON.parse(payload.data.content).body.elements;

  const infos = [];
  await sendResultCard(client, "chat-1", { delivery: { agentKey: "project_manager", agentName: "项目经理", summary: "汇总", artifactPaths: [], diagram } }, { log: { info: (m) => infos.push(m), error() {} } });
  assert.equal(uploads, 0, "项目经理不该上传架构图");
  assert.equal(elementsOf(sent[0]).some((element) => element.tag === "img"), false);
  assert.ok(infos.some((line) => line.includes("skipped for project_manager")), "跳过要留日志");

  await sendResultCard(client, "chat-1", { delivery: { agentKey: "architect", agentName: "架构设计师", summary: "架构", artifactPaths: [], diagram } }, { log: { info() {}, error() {} } });
  assert.equal(uploads, 1, "架构师可以上传架构图");
  assert.equal(elementsOf(sent[1]).some((element) => element.tag === "img"), true);
});

test("delivery 自带 choices 时优先使用，不被默认确认按钮覆盖", () => {
  const restore = fakeEnv(undefined);
  try {
    const card = buildResultCard({
      delivery: deliveryOf("architect", {
        choices: [
          { id: "option_a", label: "方案 A", primary: true },
          { id: "option_b", label: "方案 B" },
        ],
      }),
    });
    assert.deepEqual(buttonLabels(card), ["方案 A", "方案 B"]);
    const values = actionElement(card).actions.map((action) => action.value);
    assert.deepEqual(values[0], { action: "choice", choice: "option_a", label: "方案 A" });
    assert.deepEqual(values[1], { action: "choice", choice: "option_b", label: "方案 B" });
  } finally {
    restore();
  }
});

test("result.approvalRequired:true 仍强制出按钮（即使角色不在白名单且 final）", () => {
  const restore = fakeEnv("project_manager");
  try {
    const card = buildResultCard({ approvalRequired: true, delivery: deliveryOf("tester", { final: true }) });
    assert.deepEqual(buttonLabels(card), ["确认执行"]);
  } finally {
    restore();
  }
});

test("未显式选角色的普通回复卡片不带按钮（暂停/恢复/任务接收路径不回归）", () => {
  const restore = fakeEnv(undefined);
  try {
    const card = buildResultCard({ delivery: { summary: "无角色信息" } });
    assert.equal(actionElement(card), undefined);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// T2：回调同步响应体
// ---------------------------------------------------------------------------

test("approve 回调返回 toast 响应体且保留 sendCard 副作用", async () => {
  const sent = [];
  const { handler, calls } = makeHandler({ sent });
  const response = await handler({
    context: { open_chat_id: "chat-1" },
    action: { value: { action: "approve", choice: "approve", label: "确认执行" } },
  });
  assert.deepEqual(response, { toast: { type: "success", content: "已确认，正在继续执行" } });
  assert.deepEqual(calls, [{ chatId: "chat-1", selection: "approve" }]);
  assert.equal(sent.length, 1, "仍应发一张留痕卡片");
  assert.match(sent[0].header.title.content, /架构设计师/);
});

test("choice 回调透传 value.choice 作为 selection", async () => {
  const sent = [];
  const { handler, calls } = makeHandler({ sent });
  const response = await handler({
    context: { open_chat_id: "chat-2" },
    action: { value: { action: "choice", choice: "option_b", label: "方案 B" } },
  });
  assert.equal(response.toast.type, "success");
  assert.deepEqual(calls, [{ chatId: "chat-2", selection: "option_b" }]);
});

test("无待确认任务时返回 warning toast，不静默", async () => {
  const sent = [];
  const { handler } = makeHandler({ resolveLatest: async () => null, sent });
  const response = await handler({
    context: { open_chat_id: "chat-3" },
    action: { value: { action: "approve", choice: "approve" } },
  });
  assert.deepEqual(response, { toast: { type: "warning", content: "当前没有等待确认的任务" } });
  assert.equal(sent.length, 1, "无待确认也要有可见反馈卡片");
  assert.match(sent[0].body.elements[0].text.content, /没有等待选择的任务/);
});

test("重复点击同一待确认项：第二次返回 warning 且不重复派发", async () => {
  let pending = true;
  const calls = [];
  const { handler } = makeHandler({
    resolveLatest: async (chatId, selection) => {
      calls.push({ chatId, selection });
      if (!pending) return null;
      pending = false;
      return { approved: true, agentKey: "project_manager", agentName: "项目经理" };
    },
  });
  const event = { context: { open_chat_id: "chat-4" }, action: { value: { action: "approve", choice: "approve" } } };
  const first = await handler(event);
  const second = await handler(event);
  assert.equal(first.toast.type, "success");
  assert.equal(second.toast.type, "warning");
  assert.equal(calls.length, 2, "handler 允许被再次调用，但编排层不应再派发");
  assert.equal(pending, false);
});

test("非白名单 action 不误触发 resolveLatest，但返回 warning 而不是 undefined", async () => {
  const sent = [];
  const { handler, calls } = makeHandler({
    sent,
    resolveLatest: async (chatId, selection) => { calls.push({ chatId, selection }); return { approved: true }; },
  });
  for (const action of ["unknown", "delete", "pause", undefined]) {
    const response = await handler({ context: { open_chat_id: "chat-5" }, action: { value: { action } } });
    assert.deepEqual(response, { toast: { type: "warning", content: "该操作无需确认或已失效" } }, `action=${action}`);
  }
  assert.deepEqual(calls, [], "非白名单 action 不得调用 resolveLatest");
  assert.deepEqual(sent, [], "非白名单 action 不得发卡片");
});

test("缺少 chatId 或缺编排器时不抛异常，返回 warning toast", async () => {
  const sent = [];
  const { handler } = makeHandler({ sent });
  assert.deepEqual(
    await handler({ action: { value: { action: "approve" } } }),
    { toast: { type: "warning", content: "该操作无需确认或已失效" } },
  );
  const bare = createCardActionHandler({});
  const response = await bare({ context: { open_chat_id: "c" }, action: { value: { action: "approve" } } });
  assert.equal(response.toast.type, "warning");
  assert.deepEqual(sent, []);
});

test("resolveLatest 抛异常时返回 error toast 并记录日志，不外抛", async () => {
  const errors = [];
  const { handler } = makeHandler({
    resolveLatest: async () => { throw new Error("boom"); },
    log: { error: (message) => errors.push(message) },
  });
  const response = await handler({ context: { open_chat_id: "chat-6" }, action: { value: { action: "approve" } } });
  assert.deepEqual(response, { toast: { type: "error", content: "确认失败，请查看网关日志" } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /boom/);
});

test("响应体只含 toast，不回吐 delivery 正文（防信息泄漏/超长）", async () => {
  const secret = "内部实现细节".repeat(200);
  const { handler } = makeHandler({
    resolveLatest: async () => ({ approved: true, agentKey: "backend_developer", agentName: "后端开发", delivery: { summary: secret } }),
  });
  const response = await handler({ context: { open_chat_id: "chat-7" }, action: { value: { action: "approve" } } });
  assert.deepEqual(Object.keys(response), ["toast"]);
  assert.deepEqual(Object.keys(response.toast).sort(), ["content", "type"]);
  assert.ok(!JSON.stringify(response).includes("内部实现细节"));
});

test("event 包装形式（event.event.context）同样可解析并返回 toast", async () => {
  const sent = [];
  const { handler, calls } = makeHandler({ sent });
  const response = await handler({
    event: { context: { open_chat_id: "chat-8" }, action: { value: { action: "approve" } } },
  });
  assert.equal(response.toast.type, "success");
  assert.deepEqual(calls, [{ chatId: "chat-8", selection: "approve" }]);
});

test("SDK 规范化后的卡片事件使用顶层 chatId 和 action.value", async () => {
  const sent = [];
  const { handler, calls } = makeHandler({ sent });
  const response = await handler({
    messageId: "om_card_1",
    chatId: "chat-normalized",
    action: { value: { action: "approve", choice: "approve" } },
    operator: { openId: "ou_user_1" },
  });
  assert.equal(response.toast.type, "success");
  assert.deepEqual(calls, [{ chatId: "chat-normalized", selection: "approve" }]);
});

test("卡片 action.value 为 JSON 字符串时也能解析", async () => {
  const sent = [];
  const { handler, calls } = makeHandler({ sent });
  const response = await handler({
    messageId: "om_card_2",
    chatId: "chat-string-value",
    action: { value: JSON.stringify({ action: "choice", choice: "option_b" }) },
    operator: { openId: "ou_user_2" },
  });
  assert.equal(response.toast.type, "success");
  assert.deepEqual(calls, [{ chatId: "chat-string-value", selection: "option_b" }]);
});

// ---------------------------------------------------------------------------
// T1+T2 联合：六角色卡片 → 点击 → toast 闭环
// ---------------------------------------------------------------------------

test("六角色卡片到回调的闭环：每张卡片点击后都有 toast 且只派发一次", async () => {
  const restore = fakeEnv(undefined);
  try {
    for (const agentKey of ALL_ROLES) {
      const card = buildResultCard({ delivery: deliveryOf(agentKey) });
      const value = actionElement(card).actions[0].value;
      let dispatched = 0;
      let pending = true;
      const { handler } = makeHandler({
        resolveLatest: async () => {
          if (!pending) return null;
          pending = false;
          dispatched += 1;
          return { approved: true, agentKey, agentName: agentKey };
        },
      });
      const event = { context: { open_chat_id: `chat-${agentKey}` }, action: { value } };
      const first = await handler(event);
      const second = await handler(event);
      assert.equal(first.toast.type, "success", `${agentKey} 首次点击`);
      assert.equal(second.toast.type, "warning", `${agentKey} 二次点击`);
      assert.equal(dispatched, 1, `${agentKey} 只应派发一次`);
    }
  } finally {
    restore();
  }
});

test("文本兜底路径不受本次改动影响（确认执行仍被识别）", () => {
  assert.equal(isApprovalCommand("确认执行"), true);
  assert.equal(isApprovalCommand("批准"), true);
  assert.equal(isApprovalCommand("确认一下"), false);
});
