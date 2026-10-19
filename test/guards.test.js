import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVerbalDispatch, inferDispatchTargets, validateAcceptance } from "../src/orchestrator/guards.js";
import { createDeliverTool, droppedAssignments } from "../src/agent/tools.js";

test("dispatch guard flags a PM that claims to have dispatched without assignments", () => {
  assert.equal(detectVerbalDispatch({ delivery: { summary: "已派发给前端开发实现登录页" } })?.reason, "verbal_claim");
  assert.equal(detectVerbalDispatch({ delivery: { summary: "方案已定", next: "交给测试验证" } })?.reason, "verbal_claim");
  assert.equal(detectVerbalDispatch({ delivery: { summary: "x" }, resultText: "我已经安排后端处理" })?.reason, "verbal_claim");
});

test("dispatch guard flags assignments that were all dropped as invalid", () => {
  const detection = detectVerbalDispatch({ delivery: { summary: "计划", assignments: [], droppedAssignments: [{ agentKey: "frontend", reason: "未知角色" }] } });
  assert.equal(detection?.reason, "dropped_assignments");
  assert.match(detection.detail, /frontend（未知角色）/);
});

test("dispatch guard leaves real dispatches, final summaries, choices and plain answers alone", () => {
  assert.equal(detectVerbalDispatch({ delivery: { summary: "已派发给前端", assignments: [{ agentKey: "frontend_developer", task: "x" }] } }), null);
  assert.equal(detectVerbalDispatch({ delivery: { summary: "前端已交给测试验证完毕，全部完成", final: true } }), null);
  assert.equal(detectVerbalDispatch({ delivery: { summary: "交给前端还是后端？", choices: [{ id: "a", label: "前端" }] } }), null);
  assert.equal(detectVerbalDispatch({ delivery: { summary: "当前共有 3 个项目：one、test1、student2" } }), null);
});

test("fallback dispatch infers named roles that are registered, never the PM itself", () => {
  const keys = ["project_manager", "architect", "frontend_developer", "tester"];
  assert.deepEqual(inferDispatchTargets("已交给前端开发和测试", keys), ["frontend_developer", "tester"]);
  assert.deepEqual(inferDispatchTargets("交给后端处理", keys), [], "unregistered backend is ignored");
  assert.deepEqual(inferDispatchTargets("项目经理自己完成", keys), []);
});

test("acceptance pass needs every check passing and at least one piece of evidence", () => {
  const base = { verdict: "pass", checks: [{ id: "AC1", title: "登录成功", status: "pass" }] };
  assert.equal(validateAcceptance(base).valid, false, "no evidence");
  assert.equal(validateAcceptance({ ...base, evidence: [{ kind: "command", text: "npm test 12/12" }] }).valid, true);
  const mixed = validateAcceptance({ ...base, checks: [...base.checks, { title: "错误提示", status: "fail" }], evidence: [{ kind: "note", text: "x" }] });
  assert.equal(mixed.valid, false);
  assert.match(mixed.errors.join(), /所有检查都必须为 pass/);
});

test("acceptance fail needs a failing check and skip needs a reason", () => {
  assert.equal(validateAcceptance({ verdict: "fail", checks: [{ title: "a", status: "pass" }] }).valid, false);
  assert.equal(validateAcceptance({ verdict: "fail", checks: [{ title: "a", status: "fail", detail: "500" }] }).valid, true);
  assert.equal(validateAcceptance({ verdict: "skip" }).valid, false);
  assert.equal(validateAcceptance({ verdict: "skip", skipReason: "纯库无界面" }).valid, true);
  assert.equal(validateAcceptance({ verdict: "ok" }).valid, false);
  assert.equal(validateAcceptance(null).valid, false);
});

test("droppedAssignments explains why each PM assignment was discarded", () => {
  const dropped = droppedAssignments([
    { agentKey: "frontend", task: "x" },
    { agentKey: "project_manager", task: "x" },
    { agentKey: "tester", task: "" },
    { agentKey: "architect", task: "design" },
    { agentKey: "architect", task: "again" },
  ], { selfAgentKey: "project_manager" });
  assert.deepEqual(dropped.map((item) => item.reason), ["未知角色", "不能派给自己", "缺少 task", "重复派发"]);
});

test("deliver_artifact rejects a tester delivery without valid acceptance and checks evidence files", async () => {
  const root = await mkdtemp(join(tmpdir(), "deliver-acceptance-"));
  try {
    await mkdir(join(root, "workspace", "demo", "artifacts"), { recursive: true });
    await writeFile(join(root, "workspace", "demo", "artifacts", "report.md"), "ok");
    const delivered = [];
    const tool = createDeliverTool({
      root,
      getArtifactsDir: () => join(root, "workspace", "demo", "artifacts"),
      getProjectName: () => "demo",
      agentKey: "tester",
      agentName: "测试",
      onDeliver: (delivery) => delivered.push(delivery),
    });
    const missing = await tool.execute("c1", { summary: "测了" });
    assert.match(missing.content[0].text, /验收结果校验失败/);
    const badFile = await tool.execute("c2", { summary: "测了", acceptance: { verdict: "pass", checks: [{ title: "a", status: "pass" }], evidence: [{ kind: "file", path: "artifacts/nope.md" }] } });
    assert.match(badFile.content[0].text, /证据文件 artifacts\/nope\.md 不可用/);
    assert.equal(delivered.length, 0);
    const ok = await tool.execute("c3", { summary: "测了", acceptance: { verdict: "pass", checks: [{ title: "a", status: "pass" }], evidence: [{ kind: "file", path: "artifacts/report.md" }] } });
    assert.match(ok.content[0].text, /已交付/);
    assert.equal(delivered[0].acceptance.verdict, "pass");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("deliver_artifact records PM assignments that were dropped", async () => {
  const root = await mkdtemp(join(tmpdir(), "deliver-dropped-"));
  try {
    const delivered = [];
    const tool = createDeliverTool({ root, getArtifactsDir: () => root, getProjectName: () => null, agentKey: "project_manager", agentName: "PM", onDeliver: (delivery) => delivered.push(delivery) });
    await tool.execute("c1", { summary: "派发", assignments: [{ agentKey: "frontend", task: "做页面" }] });
    assert.deepEqual(delivered[0].assignments, []);
    assert.deepEqual(delivered[0].droppedAssignments, [{ agentKey: "frontend", reason: "未知角色" }]);
    assert.equal(delivered[0].acceptance, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
