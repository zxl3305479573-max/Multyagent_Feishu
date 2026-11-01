// 架构流程图渲染：把「节点 + 连线」的结构化描述画成 SVG，再光栅化成 PNG。
// 不引入无头浏览器：布局规则固定（按层自上而下、层内横向排列），输出确定、可单测。
import { Resvg } from "@resvg/resvg-js";

const MAX_NODES = 24;
const MAX_EDGES = 40;
const BOX_HEIGHT = 54;
const MIN_BOX_WIDTH = 132;
const MAX_BOX_WIDTH = 260;
const GAP_X = 58;
const GAP_Y = 66;
const PADDING = 28;
// 标题较长时容易和第一行的层名（层名画在行的上方）撞在一起，留足间距。
const TITLE_HEIGHT = 64;
const FONT_SIZE = 15;
const LINE_HEIGHT = 20;
const MAX_LINES = 2;
const MIN_CANVAS_WIDTH = 720;
// 同层间/反向边共用的偏移步长；gutter 是画布右侧给反向预留的布线区。
const LANE_GAP = 12;
const GUTTER_LABEL_WIDTH = 84;
const PORT_GAP = 14;

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

function roundedPath(points, radius = 8) {
  if (points.length < 2) return "";
  const parts = [`M ${points[0][0]} ${points[0][1]}`];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    if (!next) {
      parts.push(`L ${current[0]} ${current[1]}`);
      break;
    }
    const beforeLength = Math.max(Math.abs(current[0] - previous[0]), Math.abs(current[1] - previous[1]));
    const afterLength = Math.max(Math.abs(next[0] - current[0]), Math.abs(next[1] - current[1]));
    const before = Math.min(radius, beforeLength / 2);
    const after = Math.min(radius, afterLength / 2);
    const beforePoint = [
      current[0] + Math.sign(previous[0] - current[0]) * before,
      current[1] + Math.sign(previous[1] - current[1]) * before,
    ];
    const afterPoint = [
      current[0] + Math.sign(next[0] - current[0]) * after,
      current[1] + Math.sign(next[1] - current[1]) * after,
    ];
    parts.push(`L ${beforePoint[0]} ${beforePoint[1]} Q ${current[0]} ${current[1]} ${afterPoint[0]} ${afterPoint[1]}`);
  }
  return parts.join(" ");
}

// 校验并归一化外部传入的图描述；不合法就返回 null（调用方据此跳过嵌图）。
// 节点标签里已经写了“领域层/策略层”这类层名时，以标签为准纠正 layer 字段，
// 避免模型把不同层复用成同一个 layer 导致两行被错误合并。
const LAYER_TOKENS = ["接入层", "编排层", "策略层", "领域层", "数据层", "观测层"];

function deriveLayer(label, fallback) {
  const head = String(label).split(/[·\s:：\-—]/)[0];
  return LAYER_TOKENS.find((token) => head.endsWith(token)) || fallback || null;
}

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
    const fallbackLayer = String(item?.layer ?? item?.group ?? "").trim() || null;
    nodes.push({ id, label, layer: deriveLayer(label, fallbackLayer) });
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
  const baseCanvasWidth = Math.max(MIN_CANVAS_WIDTH, Math.max(...rowWidths) + PADDING * 2);
  const layerIndexOf = new Map();
  rows.forEach((row, rowIndex) => row.nodes.forEach((node) => layerIndexOf.set(node.id, rowIndex)));

  // 边的三类走法：相邻正向边走层间通道；同层但中间隔着方框的边走行外通道；
  // 反向边和跨多层的边统一走右侧 gutter，避免竖向路径穿过方框。
  const forwardByPair = new Map();
  const gutterEdges = [];
  const sameLayerStraight = [];
  const sameLayerRouted = [];
  for (const edge of diagram.edges) {
    const fromRow = layerIndexOf.get(edge.from);
    const toRow = layerIndexOf.get(edge.to);
    if (toRow > fromRow && toRow === fromRow + 1) {
      const key = `${fromRow}->${toRow}`;
      const group = forwardByPair.get(key) || [];
      group.push(edge);
      forwardByPair.set(key, group);
    } else if (toRow === fromRow) {
      const row = rows[fromRow];
      const fromIndex = row.nodes.findIndex((node) => node.id === edge.from);
      const toIndex = row.nodes.findIndex((node) => node.id === edge.to);
      if (Math.abs(toIndex - fromIndex) > 1) sameLayerRouted.push({ edge, rowIndex: fromRow, lastRow: fromRow === rows.length - 1 });
      else sameLayerStraight.push(edge);
    } else {
      gutterEdges.push(edge);
    }
  }
  gutterEdges.forEach((edge, index) => { edge.lane = index; });
  const forwardOutCount = new Map();
  const forwardInCount = new Map();
  for (const group of forwardByPair.values()) {
    for (const edge of group) {
      forwardOutCount.set(edge.from, (forwardOutCount.get(edge.from) || 0) + 1);
      forwardInCount.set(edge.to, (forwardInCount.get(edge.to) || 0) + 1);
    }
  }
  const gutterOutCount = new Map();
  const gutterInCount = new Map();
  for (const edge of gutterEdges) {
    gutterOutCount.set(edge.from, (gutterOutCount.get(edge.from) || 0) + 1);
    gutterInCount.set(edge.to, (gutterInCount.get(edge.to) || 0) + 1);
  }
  const forwardOutSeen = new Map();
  const forwardInSeen = new Map();
  const gutterOutSeen = new Map();
  const gutterInSeen = new Map();
  const portOffset = (seen, counts, id) => {
    const index = seen.get(id) || 0;
    seen.set(id, index + 1);
    return (index - ((counts.get(id) || 1) - 1) / 2) * PORT_GAP;
  };
  const gutterBase = baseCanvasWidth - PADDING + 22;
  const rightGutterWidth = gutterEdges.length ? 22 + (gutterEdges.length - 1) * LANE_GAP + GUTTER_LABEL_WIDTH : 0;
  const canvasWidth = baseCanvasWidth + rightGutterWidth;
  const belowLaneCount = sameLayerRouted.filter((item) => item.lastRow).length;
  const canvasHeight = PADDING * 2 + (diagram.title ? TITLE_HEIGHT : 0) + rows.length * BOX_HEIGHT + (rows.length - 1) * GAP_Y + belowLaneCount * LANE_GAP;

  const boxes = new Map();
  const layerLabels = [];
  rows.forEach((row, rowIndex) => {
    const startX = (baseCanvasWidth - rowWidths[rowIndex]) / 2;
    let x = startX;
    const y = PADDING + (diagram.title ? TITLE_HEIGHT : 0) + rowIndex * (BOX_HEIGHT + GAP_Y);
    if (row.name) layerLabels.push({ text: row.name, x: PADDING, y: y - 10 });
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

  const labelBoxes = [];
  const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const adjustLabelY = (x, y, width) => {
    let candidateY = Math.max(20, y);
    for (let guard = 0; guard < 12; guard += 1) {
      const box = { x: x - width / 2, y: candidateY - 16, width, height: 12 };
      if (!labelBoxes.some((placed) => overlaps(placed, box))) {
        labelBoxes.push(box);
        return candidateY;
      }
      candidateY -= 15;
    }
    return candidateY;
  };
  const drawEdge = (edge, path, labelX, labelY) => {
    parts.push(`<path data-edge="${edge.from}->${edge.to}" d="${path}" fill="none" stroke="#4f5d75" stroke-width="1.6" marker-end="url(#arrow)"/>`);
    if (!edge.label) return;
    const width = Math.ceil(textWidth(edge.label) + 10);
    const placedY = adjustLabelY(labelX, labelY, width);
    parts.push(`<rect x="${labelX - width / 2}" y="${placedY - 16}" width="${width}" height="12" rx="2" fill="#f5f5f5"/>`);
    parts.push(`<text x="${labelX}" y="${placedY - 6}" font-size="11" text-anchor="middle" fill="#7a8399">${escapeXml(edge.label)}</text>`);
  };

  for (const group of forwardByPair.values()) {
    group.forEach((edge, index) => {
      const from = boxes.get(edge.from);
      const to = boxes.get(edge.to);
      const fromCx = from.x + from.width / 2 + portOffset(forwardOutSeen, forwardOutCount, edge.from);
      const toCx = to.x + to.width / 2 + portOffset(forwardInSeen, forwardInCount, edge.to);
      const gapTop = from.y + from.height;
      const gapBottom = to.y;
      const offset = (index - (group.length - 1) / 2) * LANE_GAP;
      const midY = Math.min(gapBottom - 8, Math.max(gapTop + 8, (gapTop + gapBottom) / 2 + offset));
      drawEdge(
        edge,
        roundedPath([[fromCx, gapTop], [fromCx, midY], [toCx, midY], [toCx, gapBottom]]),
        (fromCx + toCx) / 2,
        midY - 6,
      );
    });
  }

  for (const edge of sameLayerStraight) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    const rightward = to.x >= from.x;
    const startX = rightward ? from.x + from.width : from.x;
    const endX = rightward ? to.x : to.x + to.width;
    const y = from.y + from.height / 2;
    drawEdge(edge, roundedPath([[startX, y], [endX, y]]), (startX + endX) / 2, y - 8);
  }

  const aboveLane = new Map();
  let belowLane = 0;
  for (const item of sameLayerRouted) {
    const { edge } = item;
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    const fromCx = from.x + from.width / 2;
    const toCx = to.x + to.width / 2;
    if (item.lastRow) {
      const laneY = from.y + from.height + 18 + belowLane * LANE_GAP;
      belowLane += 1;
      drawEdge(edge, roundedPath([[fromCx, from.y + from.height], [fromCx, laneY], [toCx, laneY], [toCx, to.y + to.height]]), (fromCx + toCx) / 2, laneY + 6);
    } else {
      const lane = aboveLane.get(item.rowIndex) || 0;
      aboveLane.set(item.rowIndex, lane + 1);
      const laneY = from.y - 16 - lane * LANE_GAP;
      drawEdge(edge, roundedPath([[fromCx, from.y], [fromCx, laneY], [toCx, laneY], [toCx, to.y]]), (fromCx + toCx) / 2, laneY - 6);
    }
  }

  for (const edge of gutterEdges) {
    const from = boxes.get(edge.from);
    const to = boxes.get(edge.to);
    const gutterX = gutterBase + edge.lane * LANE_GAP;
    const startY = from.y + from.height / 2 + portOffset(gutterOutSeen, gutterOutCount, edge.from);
    const endY = to.y + to.height / 2 + portOffset(gutterInSeen, gutterInCount, edge.to);
    const labelWidth = edge.label ? Math.ceil(textWidth(edge.label) + 10) : 0;
    drawEdge(
      edge,
      roundedPath([[from.x + from.width, startY], [gutterX, startY], [gutterX, endY], [to.x + to.width, endY]]),
      gutterX + (labelWidth ? labelWidth / 2 + 4 : 0),
      (startY + endY) / 2 - 6,
    );
  }

  for (const label of layerLabels) {
    parts.push(`<text x="${label.x}" y="${label.y}" font-size="12" fill="#8f959e">${escapeXml(label.text)}</text>`);
  }

  for (const node of diagram.nodes) {
    const box = boxes.get(node.id);
    const lines = wrapLabel(node.label, box.width - 24);
    const startY = box.y + box.height / 2 - ((lines.length - 1) * LINE_HEIGHT) / 2 + FONT_SIZE / 3;
    parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="6" fill="#ffffff" stroke="#2d3142" stroke-width="1.2"/>`);
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
