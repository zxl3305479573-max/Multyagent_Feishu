#!/usr/bin/env node
// 切片统计报告：汇总事件日志里每个切片的耗时、失败率与规模分布，以及粒度门禁的打回比例，
// 用来校准 PI_SLICE_MAX_CRITERIA / PI_SLICE_MAX_TASK_CHARS / PI_SLICE_MAX_LIST_ITEMS。
//
// 用法：
//   node scripts/slice-stats.mjs                    读取 runtime/events.jsonl（或 PI_EVENTS_FILE）
//   node scripts/slice-stats.mjs --days 7           只统计最近 7 天
//   node scripts/slice-stats.mjs --file <路径>      指定事件日志（桌面端在其数据目录的 runtime/ 下）
import { resolve } from "node:path";
import { forEachEvent } from "../src/event-log.js";
import { summarizeSliceStats } from "../src/slice-stats.js";

const args = process.argv.slice(2);
const arg = (name) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const file = resolve(arg("file") || process.env.PI_EVENTS_FILE || "runtime/events.jsonl");
const days = Number(arg("days") || 0);

const events = [];
const read = await forEachEvent(file, (event) => {
  if (event.type === "slice_finished" || (event.type === "delivery_received" && event.agent === "project_manager")) events.push(event);
});
if (!read) {
  console.error(`没有读到事件：${file}`);
  process.exit(1);
}
const stats = summarizeSliceStats(events, { since: days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0 });
console.log(JSON.stringify({ file, days: days || null, ...stats }, null, 2));
