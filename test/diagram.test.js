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
