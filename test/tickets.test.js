import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubClient } from "../src/tickets/github.js";
import { matchesThreshold, priorityOf } from "../src/tickets/priority.js";
import { downloadImages, extractImageUrls } from "../src/tickets/images.js";
import { buildWritebackComment, createTicketService } from "../src/tickets/service.js";
import { createCardActionHandler } from "../src/gateway.js";

test("priority is inferred from common label conventions", () => {
  assert.deepEqual(priorityOf(["bug", "P0"]), { rank: 0, label: "紧急" });
  assert.equal(priorityOf(["priority: high"]).rank, 10);
  assert.equal(priorityOf(["优先级：中"]).rank, 20);
  assert.equal(priorityOf(["low"]).rank, 30);
  assert.equal(priorityOf(["bug", "enhancement"]).rank, 50);
  assert.equal(priorityOf(["P2", "critical"]).rank, 0, "the most urgent label wins");
});

test("pull thresholds never auto-pull medium or low tickets", () => {
  const p = (rank) => ({ rank });
  assert.equal(matchesThreshold(p(0), "severe"), true);
  assert.equal(matchesThreshold(p(10), "severe"), false);
  assert.equal(matchesThreshold(p(10), "major"), true);
  assert.equal(matchesThreshold(p(50), "major"), false);
  assert.equal(matchesThreshold(p(50), "all"), true);
  assert.equal(matchesThreshold(p(20), "all"), false);
});

function fakeResponse(body, { status = 200, type = "application/json" } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return { ok: status < 400, status, headers: { get: () => type }, text: async () => buffer.toString(), arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) };
}

test("GitHub client sends the token, drops pull requests and reports API errors", async () => {
  const calls = [];
  const client = createGitHubClient({ token: "ghp_test", fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/issues/9")) return fakeResponse({ message: "Not Found" }, { status: 404 });
    return fakeResponse([{ number: 1, title: "Bug", labels: [{ name: "P1" }], html_url: "u1", state: "open" }, { number: 2, title: "PR", pull_request: {}, labels: [] }]);
  } });
  const issues = await client.listOpenIssues("acme/app", { labels: ["bug"] });
  assert.deepEqual(issues.map((issue) => issue.number), [1]);
  assert.equal(issues[0].priority.rank, 10);
  assert.equal(calls[0].init.headers.authorization, "Bearer ghp_test");
  assert.match(calls[0].url, /labels=bug/);
  await assert.rejects(client.getIssue("acme/app", 9), /404.*Not Found/);
  await assert.rejects(createGitHubClient({ token: "" }).getIssue("acme/app", 1), /GITHUB_TOKEN/);
  await assert.rejects(client.getIssue("../etc", 1), /owner\/name/);
});

test("issue images are extracted and downloaded, sending the token only to GitHub hosts", async () => {
  const body = "![shot](https://github.com/user-attachments/assets/a.png) <img src=\"https://cdn.example.com/b.jpg\"> ![rel](./c.png)";
  assert.deepEqual(extractImageUrls(body), ["https://github.com/user-attachments/assets/a.png", "https://cdn.example.com/b.jpg"]);
  const dir = await mkdtemp(join(tmpdir(), "ticket-images-"));
  try {
    const headers = [];
    const results = await downloadImages({ urls: [...extractImageUrls(body), "https://cdn.example.com/page"], dir, token: "ghp_x", fetchImpl: async (url, init) => {
      headers.push(init.headers);
      return url.endsWith("page") ? fakeResponse("<html>", { type: "text/html" }) : fakeResponse(Buffer.from([1, 2, 3]), { type: url.endsWith(".png") ? "image/png" : "image/jpeg" });
    } });
    assert.equal(headers[0].authorization, "Bearer ghp_x");
    assert.equal(headers[1].authorization, undefined, "third-party hosts never receive the token");
    assert.match(results[0].path, /image-1\.png$/);
    assert.match(results[2].error, /不是图片/);
    assert.equal((await readFile(results[1].path)).length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function harness({ issues = [], confirm = true } = {}) {
  const comments = [];
  const closed = [];
  const submitted = [];
  const cards = [];
  const events = [];
  const store = new Map(issues.map((issue) => [issue.number, { body: "", url: `https://github.com/acme/app/issues/${issue.number}`, state: "open", labels: [], ...issue }]));
  const withPriority = (issue) => ({ ...issue, priority: priorityOf(issue.labels) });
  const client = {
    hasToken: () => true,
    listOpenIssues: async () => [...store.values()].filter((issue) => issue.state === "open").map(withPriority),
    getIssue: async (_repo, number) => withPriority(store.get(Number(number))),
    comment: async (repo, number, body) => { comments.push({ repo, number, body }); return { url: `c${comments.length}` }; },
    close: async (repo, number) => { closed.push(number); },
  };
  return { comments, closed, submitted, cards, events, store, confirm, client };
}

async function createService(h, dir, extra = {}) {
  let counter = 0;
  const service = createTicketService({
    file: join(dir, "tickets.json"),
    client: h.client,
    workspaceRoot: dir,
    downloader: async ({ urls }) => urls.map((url, index) => ({ url, path: join(dir, `image-${index + 1}.png`) })),
    submitTask: async (input) => {
      const existing = h.submitted.find((item) => item.idempotencyKey === input.idempotencyKey);
      if (existing) return { taskId: existing.taskId, duplicate: true };
      const taskId = `TASK-${++counter}`;
      h.submitted.push({ ...input, taskId });
      return { taskId };
    },
    recordEvent: async (event) => h.events.push(event),
    sendCard: async (chatId, card) => h.cards.push({ chatId, card }),
    defaultChatId: "oc_team",
    log: { warn() {}, error() {} },
    ...extra,
  });
  const source = await service.saveSource({ repo: "acme/app", project: "demo", autoClose: true, pull: { enabled: true, everyHours: 2, threshold: "major", confirmInFeishu: h.confirm } });
  return { service, source };
}

test("ticket sources are validated before saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tickets-src-"));
  try {
    const h = harness();
    const { service } = await createService(h, dir);
    await assert.rejects(service.saveSource({ repo: "not a repo", project: "demo" }), /owner\/name/);
    await assert.rejects(service.saveSource({ repo: "acme/other", project: "Bad Name" }), /本地项目/);
    await assert.rejects(service.saveSource({ repo: "ACME/app", project: "demo" }), /已经配置过/);
    await assert.rejects(service.saveSource({ repo: "acme/other", project: "demo", pull: { everyHours: 30 } }), /1 到 24/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dispatching a ticket hands a complete brief to the project manager exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tickets-dispatch-"));
  try {
    const h = harness({ issues: [{ number: 7, title: "登录报错", body: "点登录 500\n![s](https://github.com/x/a.png)", labels: ["bug", "P1"] }] });
    const { service, source } = await createService(h, dir);
    const first = await service.dispatch({ sourceId: source.id, number: 7, note: "先查后端日志" });
    const again = await service.dispatch({ sourceId: source.id, number: 7 });
    assert.equal(h.submitted.length, 1);
    assert.equal(again.duplicate, true);
    assert.equal(again.taskId, first.taskId);
    const brief = h.submitted[0];
    assert.equal(brief.projectName, "demo");
    assert.equal(brief.idempotencyKey, "ticket:github:acme/app#7");
    assert.match(brief.description, /acme\/app#7：登录报错/);
    assert.match(brief.description, /点登录 500/);
    assert.match(brief.description, /先查后端日志/);
    assert.match(brief.description, /workspace\/demo\/artifacts\/tickets\/7\/image-1\.png/);
    assert.match(brief.description, /优先级：高/);
    assert.ok(h.events.some((event) => event.type === "ticket_dispatched" && event.issue_number === 7 && event.image_count === 1));
    const inbox = await service.inbox({ sourceId: source.id });
    assert.equal(inbox.tickets[0].status, "dispatched");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("when the root task settles, the PM summary and acceptance are written back and the issue closes only on pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tickets-writeback-"));
  try {
    const h = harness({ issues: [{ number: 1, title: "A" }, { number: 2, title: "B" }] });
    const { service, source } = await createService(h, dir);
    const { taskId: t1 } = await service.dispatch({ sourceId: source.id, number: 1 });
    const { taskId: t2 } = await service.dispatch({ sourceId: source.id, number: 2 });
    await service.handleEvent({ type: "delivery_received", agent: "project_manager", task_id: `${t1}:project_manager`, summary: "修复了登录 500，补了单测" });
    await service.handleEvent({ type: "acceptance_submitted", task_id: `${t1}:tester`, verdict: "pass", summary: "全部通过", checks: [{ id: "AC1", title: "登录成功", status: "pass" }] });
    await service.handleEvent({ type: "task_settle", task_id: t1 });
    await service.handleEvent({ type: "task_settle", task_id: t1 });
    await service.handleEvent({ type: "acceptance_submitted", task_id: `${t2}:tester`, verdict: "fail", checks: [{ id: "AC1", title: "提示", status: "fail", detail: "空白" }] });
    await service.handleEvent({ type: "task_settle", task_id: t2 });
    assert.equal(h.comments.length, 2, "each settlement is written back once");
    assert.match(h.comments[0].body, /已完成/);
    assert.match(h.comments[0].body, /修复了登录 500/);
    assert.match(h.comments[0].body, /✅ AC1 登录成功/);
    assert.match(h.comments[1].body, /❌ AC1 提示：空白/);
    assert.deepEqual(h.closed, [1], "a failed acceptance keeps the issue open");
    assert.ok(h.events.some((event) => event.type === "ticket_written_back" && event.issue_number === 1 && event.closed === true));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("write-back failures are recorded instead of thrown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tickets-wbfail-"));
  try {
    const h = harness({ issues: [{ number: 3, title: "C" }] });
    h.client.comment = async () => { throw new Error("rate limited"); };
    const { service, source } = await createService(h, dir);
    const { taskId } = await service.dispatch({ sourceId: source.id, number: 3 });
    await service.handleEvent({ type: "task_failed", task_id: taskId, error: "x" });
    assert.ok(h.events.some((event) => event.type === "ticket_writeback_failed" && /rate limited/.test(event.error)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("scheduled pull asks for Feishu confirmation first; dispatch and ignore resolve the card", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tickets-pull-"));
  try {
    const h = harness({ issues: [
      { number: 10, title: "紧急故障", labels: ["P0"] },
      { number: 11, title: "高优需求", labels: ["P1"] },
      { number: 12, title: "低优", labels: ["P3"] },
      { number: 13, title: "未标注" },
    ] });
    let clock = new Date("2026-10-19T00:00:00Z");
    const { service, source } = await createService(h, dir, { now: () => clock });
    await service.tick();
    assert.equal(h.cards.length, 0, "not due yet");
    clock = new Date("2026-10-19T02:00:01Z");
    await service.tick();
    assert.deepEqual(h.cards.map((item) => item.card.body.elements[1].actions[0].value.ticket_key), ["acme/app#10", "acme/app#11"]);
    assert.equal(h.cards[0].chatId, "oc_team");
    assert.equal(h.submitted.length, 0, "nothing starts before confirmation");
    assert.match((await service.listSources())[0].pull.lastResult, /已推送飞书确认 2 张/);

    const ok = await service.handleCardAction({ decision: "dispatch", ticket_key: "acme/app#10" });
    assert.equal(ok.ok, true);
    assert.equal(h.submitted[0].idempotencyKey, "ticket:github:acme/app#10");
    assert.equal((await service.handleCardAction({ decision: "dispatch", ticket_key: "acme/app#10" })).ok, false, "a card cannot dispatch twice");
    await service.handleCardAction({ decision: "ignore", ticket_key: "acme/app#11" });
    await service.pull(source.id);
    assert.equal(h.cards.length, 2, "dispatched and ignored tickets are not pushed again");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("without Feishu confirmation a pull dispatches matching tickets directly, most urgent first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tickets-direct-"));
  try {
    const h = harness({ issues: [{ number: 21, title: "高", labels: ["P1"] }, { number: 20, title: "紧急", labels: ["P0"] }, { number: 22, title: "中", labels: ["P2"] }], confirm: false });
    const { service, source } = await createService(h, dir);
    const result = await service.pull(source.id);
    assert.deepEqual(h.submitted.map((item) => item.title), ["#20 紧急", "#21 高"]);
    assert.equal(result.handled, 2);
    assert.equal(h.cards.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("write-back comment notes when no acceptance was recorded", () => {
  assert.match(buildWritebackComment({ status: "completed", taskId: "T", project: "p" }), /没有测试验收记录/);
  assert.doesNotMatch(buildWritebackComment({ status: "failed", taskId: "T", project: "p" }), /没有测试验收记录/);
});

test("Feishu card callbacks with action=ticket are routed to the ticket service", async () => {
  const sent = [];
  const client = { im: { message: { create: async (payload) => { sent.push(payload); return { code: 0 }; } } } };
  const values = [];
  const handler = createCardActionHandler({ client, agent: { key: "project_manager", displayName: "PM" }, log: { info() {}, error() {} }, ticketActions: async (value) => { values.push(value); return { ok: true, message: "已交给项目经理" }; } });
  const reply = await handler({ action: { value: { action: "ticket", decision: "dispatch", ticket_key: "acme/app#1" } }, context: { open_chat_id: "oc_1" } });
  assert.equal(values[0].ticket_key, "acme/app#1");
  assert.deepEqual(reply, { toast: { type: "success", content: "已交给项目经理" } });
  assert.match(sent[0].data.content, /已交给项目经理/);
});
