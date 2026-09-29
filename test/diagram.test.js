import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDiagram, renderDiagramPng, renderDiagramSvg } from "../src/diagram.js";

const SPEC = {
  title: "学生管理系统架构",
  nodes: [
    { id: "web", label: "管理端 Web", layer: "前端" },
    { id: "api", label: "REST API 网关", layer: "服务端" },
    { id: "svc", label: "学生/班级/成绩服务", layer: "服务端" },
    { id: "db", label: "SQLite", layer: "数据" },
  ],
  edges: [
    { from: "web", to: "api", label: "HTTPS" },
    { from: "api", to: "svc" },
    { from: "svc", to: "db", label: "SQL" },
  ],
};

test("normalizeDiagram 丢弃脏数据且不因缺节点炸掉", () => {
  assert.equal(normalizeDiagram(null), null);
  assert.equal(normalizeDiagram({ nodes: [] }), null);
  assert.equal(normalizeDiagram({ nodes: [{ id: "", label: "x" }] }), null);

  const cleaned = normalizeDiagram({
    nodes: [{ id: "a", label: "A" }, { id: "a", label: "重复" }, { id: "b", label: "B" }],
    edges: [{ from: "a", to: "b" }, { from: "a", to: "不存在" }, { from: "a", to: "a" }, { from: "a", to: "b" }],
  });
  assert.deepEqual(cleaned.nodes.map((node) => node.label), ["A", "B"]);
  assert.deepEqual(cleaned.edges, [{ from: "a", to: "b", label: null }]);
});

test("renderDiagramSvg 画出每个节点和每条连线，并遵循显式分层", () => {
  const svg = renderDiagramSvg(SPEC);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  for (const label of ["学生管理系统架构", "管理端 Web", "REST API 网关", "SQLite", "HTTPS", "SQL"]) {
    assert.ok(svg.includes(label) || svg.includes(label.replace(" ", " ")), `SVG 应包含 ${label}`);
  }
  assert.equal((svg.match(/marker-end="url\(#arrow\)"/g) || []).length, 3, "每条线一个箭头");
  // 同一层的两个节点必须同 y（同层并排）
  const ys = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="[\d.]+" height="54"/g)].map((m) => m[2]);
  assert.equal(ys.length, 4);
  assert.equal(ys[1], ys[2], "同一层的节点应并排在同一行");
});

test("renderDiagramSvg 没有分层信息时按最长路径自动分层", () => {
  const svg = renderDiagramSvg({
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
  });
  const ys = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="[\d.]+" height="54"/g)].map((m) => Number(m[2]));
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2], `三层应自上而下递增，实际 ${ys.join(",")}`);
});

test("renderDiagramSvg 使用圆角正交连线和低密度白底节点样式", () => {
  const svg = renderDiagramSvg(SPEC);
  assert.match(svg, /Q [\d.]+ [\d.]+ [\d.]+ [\d.]+/);
  assert.match(svg, /fill="#ffffff" stroke="#2d3142"/);
  assert.match(svg, /fill="#f5f5f5"/);
  assert.doesNotMatch(svg, /stroke="#3370ff"/);
});

test("renderDiagramPng 产出真正的 PNG", () => {
  const png = renderDiagramPng(SPEC, { width: 800 });
  assert.ok(Buffer.isBuffer(png));
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "PNG magic");
  assert.ok(png.length > 1000, `PNG 不应是空图，实际 ${png.length} 字节`);
});

test("renderDiagramPng 对空描述返回 null 而不是抛异常", () => {
  assert.equal(renderDiagramPng({ nodes: [] }), null);
  assert.equal(renderDiagramPng(null), null);
});

const ROUTING_SPEC = {
  title: "分层架构",
  nodes: [
    { id: "feishu", label: "飞书项目群 · 六机器人", layer: "接入层" },
    { id: "gw", label: "网关 · 去重/身份回帖", layer: "接入层" },
    { id: "orch", label: "任务编排层 · 星型中介", layer: "编排层" },
    { id: "roles", label: "六角色平级会话", layer: "运行时" },
    { id: "policy", label: "策略层 · tool_call 拦截", layer: "策略层" },
    { id: "domain", label: "领域层 · 交付包/DAG/状态机", layer: "策略层" },
    { id: "store", label: "TaskStore · 唯一事实来源", layer: "数据层" },
    { id: "art", label: "产物仓库 workspace", layer: "数据层" },
    { id: "obs", label: "观测 · 看板/Trace 投影", layer: "数据层" },
  ],
  edges: [
    { from: "feishu", to: "gw" },
    { from: "gw", to: "orch", label: "task_id" },
    { from: "orch", to: "roles", label: "dispatch" },
    { from: "roles", to: "orch", label: "交付包" },
    { from: "roles", to: "policy", label: "tool_call" },
    { from: "policy", to: "domain" },
    { from: "domain", to: "art", label: "write" },
    { from: "domain", to: "store", label: "状态" },
    { from: "store", to: "obs", label: "投影" },
    { from: "art", to: "orch", label: "产物引用" },
  ],
};

function pathPoints(d) {
  const numbers = [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number);
  const points = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index], y: numbers[index + 1] });
  }
  return points;
}

function insideBox(box, point) {
  return point.x > box.x + 1 && point.x < box.x + box.width - 1 && point.y > box.y + 1 && point.y < box.y + box.height - 1;
}

test("同层跨节点边、反向边和标签不会穿框或重叠", () => {
  const svg = renderDiagramSvg(ROUTING_SPEC);
  const nodeOrder = ROUTING_SPEC.nodes.map((node) => node.id);
  const boxes = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="54"/g)]
    .map((match, index) => ({ id: nodeOrder[index], x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: 54 }));
  assert.equal(boxes.length, 9);

  const paths = [...svg.matchAll(/<path data-edge="([^"]+)" d="([^"]+)"/g)]
    .map((match) => ({ edge: match[1], points: pathPoints(match[2]) }));
  assert.equal(paths.length, 10);

  for (const { edge, points } of paths) {
    const [fromId, toId] = edge.split("->");
    for (const point of points) {
      for (const box of boxes) {
        if (box.id === fromId || box.id === toId) continue;
        assert.equal(insideBox(box, point), false, `${edge} 穿过方框 ${box.id}（${JSON.stringify(point)}）`);
      }
    }
  }

  const maxRight = Math.max(...boxes.map((box) => box.x + box.width));
  const backward = paths.find((item) => item.edge === "art->orch");
  assert.ok(backward.points.some((point) => point.x > maxRight), "反向边应走右侧通道");

  const labels = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="12" rx="2"/g)]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: 12 }));
  assert.equal(labels.length, 8);
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i];
      const b = labels[j];
      const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      assert.equal(overlap, false, `标签 ${i} 与 ${j} 重叠`);
    }
  }
});
