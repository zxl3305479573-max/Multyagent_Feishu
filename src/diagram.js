// 架构流程图渲染：把「节点 + 连线」的结构化描述画成 SVG，再光栅化成 PNG。
// 不引入无头浏览器：布局规则固定（按层自上而下、层内横向排列），输出确定、可单测。
import { Resvg } from "@resvg/resvg-js";

const MAX_NODES = 24;
const MAX_EDGES = 40;
const BOX_HEIGHT = 54;
const MIN_BOX_WIDTH = 132;
const MAX_BOX_WIDTH = 240;
const GAP_X = 58;
const GAP_Y = 66;
const PADDING = 28;
// 标题较长时容易和第一行的层名（层名画在行的上方）撞在一起，留足间距。
const TITLE_HEIGHT = 64;
const FONT_SIZE = 15;
const LINE_HEIGHT = 20;
const MAX_LINES = 2;
const MIN_CANVAS_WIDTH = 760;

function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  }[ch]));
}

// 估算文字宽度：CJK 按一个字约等于字号，ASCII 按约 0.55 字号。
function textWidth(text) {
  return [...String(text)].reduce((sum, ch) => sum + (/[\x00-\xff]/.test(ch) ? FONT_SIZE * 0.58 : FONT_SIZE), 0);
}

function wrapLabel(text, maxWidth) {
  const chars = [...String(text).trim()];
  const lines = [];
  let current = "";
  for (const ch of chars) {
    const next = current + ch;
    if (current && textWidth(next) > maxWidth && lines.length < MAX_LINES - 1) {
      lines.push(current);
      current = ch;
    } else if (textWidth(next) > maxWidth && lines.length === MAX_LINES - 1) {
      lines.push(`${next.slice(0, Math.max(1, next.length - 1))}…`);
      current = "";
      break;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, MAX_LINES);
}

// 校验并归一化外部传入的图描述；不合法就返回 null（调用方据此跳过嵌图）。
export function normalizeDiagram(spec) {
  if (!spec || typeof spec !== "object") return null;
  const rawNodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const seen = new Set();
  const nodes = [];
  for (const item of rawNodes) {
    const id = String(item?.id ?? "").trim();
    const label = String(item?.label ?? "").trim();
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label, layer: String(item?.layer ?? item?.group ?? "").trim() || null });
    if (nodes.length >= MAX_NODES) break;
  }
  if (!nodes.length) return null;

  const edges = [];
  const edgeSeen = new Set();
  for (const item of Array.isArray(spec.edges) ? spec.edges : []) {
    const from = String(item?.from ?? "").trim();
    const to = String(item?.to ?? "").trim();
    const key = `${from}->${to}`;
    if (!seen.has(from) || !seen.has(to) || from === to || edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    edges.push({ from, to, label: String(item?.label ?? "").trim() || null });
    if (edges.length >= MAX_EDGES) break;
  }
  return { title: String(spec.title ?? "").trim() || null, nodes, edges };
}

// 分层：图里显式给了 layer 就用它（按出现顺序），否则按最长路径自动分层。
function assignLayers(nodes, edges) {
  const explicit = nodes.every((node) => node.layer);
  if (explicit) {
    const order = [];
    for (const node of nodes) if (!order.includes(node.layer)) order.push(node.layer);
    return order.map((name) => ({ name, nodes: nodes.filter((node) => node.layer === name) }));
  }
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) incoming.get(edge.to).push(edge.from);
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const node of nodes) {
      for (const from of incoming.get(node.id)) {
        const next = (rank.get(from) ?? 0) + 1;
        if (next > rank.get(node.id)) {
          rank.set(node.id, next);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  const maxRank = Math.max(...rank.values());
  return Array.from({ length: maxRank + 1 }, (_, index) => ({
    name: null,
    nodes: nodes.filter((node) => rank.get(node.id) === index),
  })).filter((row) => row.nodes.length);
}

export function renderDiagramSvg(spec) {
  const diagram = normalizeDiagram(spec);
  if (!diagram) return null;
  const rows = assignLayers(diagram.nodes, diagram.edges);
  const boxWidths = new Map(diagram.nodes.map((node) => {
    const lines = wrapLabel(node.label, MAX_BOX_WIDTH - 24);
    const width = Math.min(MAX_BOX_WIDTH, Math.max(MIN_BOX_WIDTH, Math.ceil(Math.max(...lines.map(textWidth)) + 28)));
    return [node.id, width];
  }));

  const rowWidths = rows.map((row) => row.nodes.reduce((sum, node) => sum + boxWidths.get(node.id), 0) + GAP_X * (row.nodes.length - 1));
  const canvasWidth = Math.max(MIN_CANVAS_WIDTH, Math.max(...rowWidths) + PADDING * 2);
  const canvasHeight = PADDING * 2 + (diagram.title ? TITLE_HEIGHT : 0) + rows.length * BOX_HEIGHT + (rows.length - 1) * GAP_Y;

  const boxes = new Map();
  const layerLabels = [];
  rows.forEach((row, rowIndex) => {
    const startX = (canvasWidth - rowWidths[rowIndex]) / 2;
    let x = startX;
    const y = PADDING + (diagram.title ? TITLE_HEIGHT : 0) + rowIndex * (BOX_HEIGHT + GAP_Y);
    if (row.name) layerLabels.push({ text: row.name, x: startX, y: y - 10 });
    for (const node of row.nodes) {
      const width = boxWidths.get(node.id);
      boxes.set(node.id, { x, y, width, height: BOX_HEIGHT, layer: rowIndex });
      x += width + GAP_X;
    }
  });

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif">`);
  parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#646a73"/></marker></defs>');
  parts.push(`<rect width="${canvasWidth}" height="${canvasHeight}" fill="#ffffff"/>`);
  if (diagram.title) {
    parts.push(`<text x="${canvasWidth / 2}" y="${PADDING + 26}" font-size="20" font-weight="600" text-anchor="middle" fill="#1f2329">${escapeXml(diagram.title)}</text>`);
  }

  for (const edge of diagram.edges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    const fromCx = from.x + from.width / 2;
    const toCx = to.x + to.width / 2;
    let path;
    let labelX;
    let labelY;
    if (to.layer > from.layer) {
      const startY = from.y + from.height;
      const endY = to.y;
      const midY = (startY + endY) / 2;
      path = `M ${fromCx} ${startY} V ${midY} H ${toCx} V ${endY}`;
      labelX = (fromCx + toCx) / 2;
      labelY = midY - 6;
    } else if (to.layer === from.layer) {
      const rightward = toCx >= fromCx;
      const startX = rightward ? from.x + from.width : from.x;
      const endX = rightward ? to.x : to.x + to.width;
      const y = from.y + from.height / 2;
      path = `M ${startX} ${y} H ${endX}`;
      labelX = (startX + endX) / 2;
      labelY = y - 8;
    } else {
      const startX = from.x + from.width;
      const y = from.y + from.height / 2;
      const endX = toCx;
      path = `M ${startX} ${y} H ${startX + 30} V ${to.y - 26} H ${endX} V ${to.y}`;
      labelX = startX + 34;
      labelY = to.y - 32;
    }
    parts.push(`<path d="${path}" fill="none" stroke="#646a73" stroke-width="1.6" marker-end="url(#arrow)"/>`);
    if (edge.label) {
      const width = Math.ceil(textWidth(edge.label) + 10);
      parts.push(`<rect x="${labelX - width / 2}" y="${labelY - 13}" width="${width}" height="18" rx="4" fill="#ffffff"/>`);
      parts.push(`<text x="${labelX}" y="${labelY}" font-size="12" text-anchor="middle" fill="#646a73">${escapeXml(edge.label)}</text>`);
    }
  }

  for (const label of layerLabels) {
    parts.push(`<text x="${label.x}" y="${label.y}" font-size="12" fill="#8f959e">${escapeXml(label.text)}</text>`);
  }

  for (const node of diagram.nodes) {
    const box = boxes.get(node.id);
    const lines = wrapLabel(node.label, box.width - 24);
    const startY = box.y + box.height / 2 - ((lines.length - 1) * LINE_HEIGHT) / 2 + FONT_SIZE / 3;
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="10" fill="#eef4ff" stroke="#3370ff" stroke-width="1.4"/>`);
    lines.forEach((line, index) => {
      parts.push(`<text x="${box.x + box.width / 2}" y="${startY + index * LINE_HEIGHT}" font-size="${FONT_SIZE}" text-anchor="middle" fill="#1f2329">${escapeXml(line)}</text>`);
    });
  }
  parts.push("</svg>");
  return parts.join("");
}

// SVG → PNG。resvg 是预编译原生包，同步调用，失败返回 null 由调用方降级。
export function renderDiagramPng(spec, { width = 1200 } = {}) {
  const svg = renderDiagramSvg(spec);
  if (!svg) return null;
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width }, background: "#ffffff" });
  return Buffer.from(resvg.render().asPng());
}
