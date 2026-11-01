// @ts-check
// events.jsonl 的高效读取与轮转。
//
// 事件日志只追加，体积会持续增长。原先每次桌面端连接、每次状态查询都整文件读入再解析，
// 文件到几十 MB 时会明显卡顿。这里提供：
//   - forEachEvent：逐行流式读取，内存占用与文件大小无关（启动时重放用）。
//   - readEventsTail：从文件尾部按块倒读，拿到足够的事件或找到游标即停（桌面端补发/查询用）。
//   - rotateEventLog：启动时文件超过阈值则整体归档，并把未结束任务的事件带到新文件，
//     保证看板、Trace 的重放仍能还原进行中的任务。
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { writeFileAtomic } from "./atomic-file.cjs";

export async function forEachEvent(file, onEvent) {
  let stream;
  try {
    await stat(file);
    stream = createReadStream(file, { encoding: "utf8" });
  } catch {
    return 0;
  }
  let count = 0;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    count += 1;
    await onEvent(event);
  }
  return count;
}

// 从尾部倒读。filter 过滤不需要的事件；找到 cursor（event_id）时只返回它之后的事件。
// 返回 { events（按时间正序）, cursorFound, reachedStart }。
export async function readEventsTail(file, { limit = 1000, filter = null, cursor = null, chunkSize = 256 * 1024 } = {}) {
  let handle;
  try { handle = await open(file, "r"); } catch { return { events: [], cursorFound: false, reachedStart: true }; }
  try {
    const { size } = await handle.stat();
    // newest：最先读到（最新）的 limit 条；oldest：滑动窗口，保存最后读到（最旧）的 limit 条。
    // 这样即使游标很旧需要扫完整个文件，内存也只占 2×limit 条事件。
    const newest = [];
    const oldest = [];
    let position = size;
    let carry = Buffer.alloc(0);
    let cursorFound = false;
    const max = Math.max(0, Number(limit) || 0);
    const consume = (line) => {
      if (!line.trim()) return false;
      let event;
      try { event = JSON.parse(line); } catch { return false; }
      if (cursor && event.event_id === cursor) { cursorFound = true; return true; }
      if (filter && !filter(event)) return false;
      if (newest.length < max) newest.push(event);
      else if (cursor) { oldest.push(event); if (oldest.length > max) oldest.shift(); }
      // 有游标时必须继续往前找游标；没有游标时取够 limit 即可。
      return !cursor && newest.length >= max;
    };
    let done = max === 0 && !cursor;
    while (!done && position > 0) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, position);
      const buffer = Buffer.concat([chunk, carry]);
      // 第一个换行之前的部分可能是被截断的行，留到下一块拼接。
      let end = buffer.length;
      for (let i = buffer.length - 1; i >= 0; i -= 1) {
        if (buffer[i] !== 0x0a) continue;
        const line = buffer.subarray(i + 1, end).toString("utf8");
        end = i;
        if (consume(line)) { done = true; break; }
      }
      carry = done ? Buffer.alloc(0) : buffer.subarray(0, end);
    }
    if (!done && carry.length) consume(carry.toString("utf8"));
    let events;
    if (cursor && cursorFound) events = newest.concat(oldest).reverse().slice(0, max);
    else events = newest.slice().reverse();
    // 有游标但没找到：游标太旧或文件已轮转，调用方应按 reset 处理（此时返回最近 limit 条）。
    return { events, cursorFound, reachedStart: position === 0 };
  } finally {
    await handle.close();
  }
}

const rootOf = (taskId) => String(taskId || "").split(":")[0];

// 文件超过 maxBytes 时归档到 archiveDir，新文件只保留 keepTask(rootTaskId) 为真的任务事件。
// 只在网关启动、事件记录器开始写入之前调用，避免与追加写竞争。
/**
 * @param {object} options
 * @param {string} options.file
 * @param {string} [options.archiveDir]
 * @param {number} [options.maxBytes]
 * @param {(rootTaskId: string) => boolean} [options.keepTask]
 * @param {Date} [options.now]
 */
export async function rotateEventLog({ file, archiveDir = join(dirname(file), "events-archive"), maxBytes = 50 * 1024 * 1024, keepTask = () => false, now = new Date() }) {
  let size;
  try { ({ size } = await stat(file)); } catch { return { rotated: false }; }
  if (!(size > maxBytes)) return { rotated: false, size };
  const kept = [];
  await forEachEvent(file, (event) => {
    const root = rootOf(event.task_id || event.parent_task_id);
    if (root && keepTask(root)) kept.push(JSON.stringify(event));
  });
  await mkdir(archiveDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const archiveFile = join(archiveDir, `${basename(file, ".jsonl")}-${stamp}.jsonl`);
  await rename(file, archiveFile);
  await writeFileAtomic(file, kept.length ? `${kept.join("\n")}\n` : "");
  return { rotated: true, size, archiveFile, carried: kept.length };
}
