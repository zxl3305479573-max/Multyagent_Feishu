// @ts-check
// 原子写盘与 JSON 状态文件读取工具（CommonJS，ESM 与 Electron 主进程共用）。
//
// 写入：先写同目录临时文件并 fsync，再 rename 覆盖目标。进程在任意时刻被杀，
// 目标文件要么是旧的完整内容，要么是新的完整内容，不会出现半截 JSON。
// 读取：文件不存在返回 fallback；内容损坏时把原文件改名为
// `<file>.corrupt-<时间戳>` 保留现场，再按 onCorrupt 决定抛错还是回退。
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { dirname, basename, join } = require("node:path");
const { randomBytes } = require("node:crypto");

class CorruptStateFileError extends Error {
  constructor(file, backup, cause) {
    super(`状态文件已损坏：${file}${backup ? `（原文件已备份为 ${backup}）` : ""}。请检查备份后再启动，避免覆盖历史数据。`);
    this.name = "CorruptStateFileError";
    this.file = file;
    this.backup = backup;
    this.cause = cause;
  }
}

// Windows 上杀毒软件或索引服务短暂占用文件时 rename 会报 EPERM/EBUSY/EACCES，重试即可。
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function tempPathFor(file) {
  return join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
}

async function writeFileAtomic(file, data, options = {}) {
  const { encoding = "utf8", mode, retries = 5 } = typeof options === "string" ? { encoding: options } : options;
  await fsp.mkdir(dirname(file), { recursive: true });
  const temp = tempPathFor(file);
  const handle = await fsp.open(temp, "w", mode);
  try {
    await handle.writeFile(data, typeof data === "string" ? encoding : undefined);
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(temp, file);
      return;
    } catch (error) {
      if (!RETRYABLE.has(error.code) || attempt >= retries) {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

function writeFileAtomicSync(file, data, options = {}) {
  const { encoding = "utf8", mode, retries = 5 } = typeof options === "string" ? { encoding: options } : options;
  fs.mkdirSync(dirname(file), { recursive: true });
  const temp = tempPathFor(file);
  const fd = fs.openSync(temp, "w", mode);
  try {
    fs.writeFileSync(fd, data, typeof data === "string" ? encoding : undefined);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      if (!RETRYABLE.has(error.code) || attempt >= retries) {
        try { fs.rmSync(temp, { force: true }); } catch {}
        throw error;
      }
      sleepSync(20 * (attempt + 1));
    }
  }
}

function corruptBackupPath(file) {
  return `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}`;
}

function parseOrNull(text) {
  // 0 字节文件通常是旧版本非原子写盘被中断的产物，同样视为损坏。
  if (!String(text).trim()) return { ok: false, error: new Error("empty file") };
  try { return { ok: true, value: JSON.parse(text) }; } catch (error) { return { ok: false, error }; }
}

function handleCorrupt(file, error, { onCorrupt = "throw", fallback, log }, renameImpl) {
  let backup = null;
  try { backup = corruptBackupPath(file); renameImpl(file, backup); } catch { backup = null; }
  if (onCorrupt === "throw") throw new CorruptStateFileError(file, backup, error);
  log?.warn?.(`[state] ${file} 内容损坏，已备份为 ${backup || "（备份失败）"}，按空状态继续`);
  return typeof fallback === "function" ? fallback() : fallback;
}

/**
 * @typedef {object} ReadJsonOptions
 * @property {any} [fallback] 文件不存在（或 backup 模式下损坏）时的返回值；函数则调用其返回值
 * @property {"throw" | "backup"} [onCorrupt] throw：核心状态，拒绝静默清空；backup：可重建的缓存/映射，备份后回退
 * @property {{ warn?: (message: string) => void }} [log]
 */

/** @param {string} file @param {ReadJsonOptions} [options] */
async function readJsonFile(file, { fallback = null, onCorrupt = "throw", log } = {}) {
  let text;
  try { text = await fsp.readFile(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return typeof fallback === "function" ? fallback() : fallback;
    throw error;
  }
  const parsed = parseOrNull(text);
  if (parsed.ok) return parsed.value;
  return handleCorrupt(file, parsed.error, { onCorrupt, fallback, log }, fs.renameSync);
}

/** @param {string} file @param {ReadJsonOptions} [options] */
function readJsonFileSync(file, { fallback = null, onCorrupt = "throw", log } = {}) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return typeof fallback === "function" ? fallback() : fallback;
    throw error;
  }
  const parsed = parseOrNull(text);
  if (parsed.ok) return parsed.value;
  return handleCorrupt(file, parsed.error, { onCorrupt, fallback, log }, fs.renameSync);
}

module.exports = { CorruptStateFileError, writeFileAtomic, writeFileAtomicSync, readJsonFile, readJsonFileSync };
