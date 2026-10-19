import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const root = process.cwd();
const entry = join(root, "desktop", "electron", "main.cjs");
const distIndex = join(root, "dist", "desktop", "index.html");
const outputDir = join(root, "test-results", "desktop-e2e");
const screenshotPath = join(outputDir, "desktop-settings.png");
const reportPath = join(outputDir, "report.json");

if (!existsSync(distIndex)) {
  throw new Error("桌面端构建不存在，请先运行 npm run desktop:build");
}
await mkdir(outputDir, { recursive: true });
const userData = await mkdtemp(join(tmpdir(), "multyagent-desktop-e2e-"));
const steps = [];
let child = null;
let client = null;
let screenshotBase64 = "";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

class CdpClient {
  constructor(url) {
    this.url = url;
    this.sequence = 0;
    this.pending = new Map();
    this.timers = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.once("open", resolveOpen);
      this.socket.once("error", rejectOpen);
    });
    this.socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(this.timers.get(message.id));
      this.timers.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "CDP command failed"));
      else pending.resolve(message.result);
    });
    this.socket.on("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("CDP connection closed"));
      this.pending.clear();
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      this.timers.set(id, setTimeout(() => {
        this.pending.delete(id);
        this.timers.delete(id);
        rejectCommand(new Error(`CDP command timeout: ${method}`));
      }, 10_000));
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "renderer evaluation failed");
    }
    return result.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch {}
  }
}

async function waitForDebugger(deadlineMs = 30_000) {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) {
      const browserUrl = new URL(match[1]);
      const targetsUrl = `http://${browserUrl.host}/json/list`;
      for (;;) {
        try {
          const targets = await fetch(targetsUrl).then((response) => response.json());
          const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
          if (page) return page.webSocketDebuggerUrl;
        } catch {}
        if (Date.now() >= deadline) break;
        await sleep(150);
      }
    }
    if (child.exitCode !== null) throw new Error(`Electron 提前退出，退出码 ${child.exitCode}\n${stderr.slice(-3000)}`);
    await sleep(100);
  }
  throw new Error(`等待 Electron DevTools 超时\n${stderr.slice(-3000)}`);
}

async function waitFor(expression, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`等待条件超时：${message}`);
}

async function record(name, fn) {
  const startedAt = Date.now();
  await fn();
  steps.push({ name, status: "passed", durationMs: Date.now() - startedAt });
}

async function captureScreenshot() {
  const result = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  screenshotBase64 = result.data;
  await writeFile(screenshotPath, Buffer.from(result.data, "base64"));
}

try {
  child = spawn(electronPath, [
    "--remote-debugging-port=0",
    "--disable-gpu",
    `--user-data-dir=${userData}`,
    entry,
  ], {
    cwd: root,
    env: {
      ...process.env,
      PI_DESKTOP_E2E: "1",
      PI_DESKTOP_E2E_USER_DATA: userData,
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", () => {});
  const pageSocketUrl = await waitForDebugger();
  client = new CdpClient(pageSocketUrl);
  await client.connect();
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Emulation.setDeviceMetricsOverride", { width: 1320, height: 900, deviceScaleFactor: 1, mobile: false });

  await record("桌面工作台真实 Chromium 渲染", async () => {
    await waitFor("Boolean(document.querySelector('.app-shell'))", "工作台根节点");
    await waitFor("Boolean(document.querySelector('.composer'))", "对话输入框");
  });

  await record("从对话页进入运行设置", async () => {
    const clicked = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.getAttribute('title') === '运行设置');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true);
    await waitFor("Boolean(document.querySelector('.settings-section-nav'))", "运行设置左侧目录");
    await waitFor("Boolean(document.querySelector('.settings-detail'))", "运行设置右侧内容");
  });

  await record("运行设置二级目录切换", async () => {
    const count = await client.evaluate("document.querySelectorAll('.settings-section-nav button').length");
    assert.ok(count >= 2);
    const changed = await client.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.settings-section-nav button')];
      const current = buttons.findIndex((item) => item.classList.contains('is-selected'));
      const next = buttons[(current + 1) % buttons.length];
      next?.click();
      return Boolean(next);
    })()`);
    assert.equal(changed, true);
    await waitFor("Boolean(document.querySelector('.settings-detail-heading h2')?.textContent?.trim())", "二级页面标题");
  });

  await record("右侧内容滚动时左侧目录保持固定", async () => {
    const result = await client.evaluate(`(async () => {
      const nav = document.querySelector('.settings-section-nav');
      const detail = document.querySelector('.settings-detail');
      const before = nav.getBoundingClientRect().top;
      detail.scrollTop = detail.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { before, after: nav.getBoundingClientRect().top, detailScrollable: detail.scrollHeight >= detail.clientHeight };
    })()`);
    assert.equal(result.detailScrollable, true);
    assert.ok(Math.abs(result.before - result.after) < 1, `左侧目录发生位移：${result.before} -> ${result.after}`);
    await client.evaluate("document.querySelector('.settings-detail').scrollTop = 0");
  });

  await captureScreenshot();

  await record("返回对话页并保留输入框", async () => {
    const clicked = await client.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.getAttribute('title') === '返回对话');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(clicked, true);
    await waitFor("Boolean(document.querySelector('.composer textarea[aria-label=\"任务描述\"]'))", "返回后的对话输入框");
  });

  await client.evaluate("(() => { window.desktop?.quit?.(); return true; })()");
  await sleep(500);
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: 1,
    status: "passed",
    finishedAt: new Date().toISOString(),
    runner: "Electron Chromium + Chrome DevTools Protocol",
    command: "npm run test:e2e",
    exitCode: 0,
    screenshot: relative(root, screenshotPath).replaceAll("\\", "/"),
    steps,
  }, null, 2));
  console.log(`PASS 桌面端真实浏览器 E2E：${steps.length} 个步骤`);
  console.log(`截图：${screenshotPath}`);
  console.log(`报告：${reportPath}`);
} catch (error) {
  console.error(`FAIL 桌面端真实浏览器 E2E：${error?.message || error}`);
  try {
    if (client?.socket?.readyState === WebSocket.OPEN) {
      await Promise.race([captureScreenshot(), sleep(5_000)]);
    }
  } catch {}
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: 1,
    status: "failed",
    finishedAt: new Date().toISOString(),
    runner: "Electron Chromium + Chrome DevTools Protocol",
    command: "npm run test:e2e",
    exitCode: 1,
    error: String(error?.stack || error),
    screenshot: screenshotBase64 ? relative(root, screenshotPath).replaceAll("\\", "/") : null,
    steps,
  }, null, 2));
  console.error(`报告：${reportPath}`);
  process.exitCode = 1;
} finally {
  client?.close();
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      sleep(5_000),
    ]);
  }
  await rm(resolve(userData), { recursive: true, force: true });
}
