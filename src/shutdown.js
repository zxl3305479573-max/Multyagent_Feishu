// @ts-check
// 网关优雅退出。
//
// process.on("exit") 回调里的异步操作不会被等待，所以关闭 WebSocket、停止多维表格轮询、
// 刷新任务快照都必须在收到信号时主动 await 完成，再退出进程。
// 清理步骤按注册的逆序执行（后启动的先关闭），每一步单独计时，
// 某一步卡住或报错不会拖住其余步骤；整体超时后强制退出。
export function createShutdown({ log = console, timeoutMs = 10_000, exit = (code) => process.exit(code) } = {}) {
  const steps = [];
  let running = null;

  function register(name, fn) {
    if (typeof fn === "function") steps.push({ name, fn });
  }

  async function runStep({ name, fn }, stepTimeoutMs) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), stepTimeoutMs); }),
      ]);
    } catch (error) {
      log.warn?.(`[shutdown] ${name} failed: ${error?.message || error}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function shutdown(reason = "signal", code = 0) {
    if (running) return running;
    log.info?.(`[shutdown] ${reason}: stopping gateway`);
    const force = setTimeout(() => {
      log.error?.("[shutdown] graceful shutdown timed out, forcing exit");
      exit(code || 1);
    }, timeoutMs);
    running = (async () => {
      const perStep = Math.max(500, Math.floor(timeoutMs / Math.max(1, steps.length)));
      for (const step of [...steps].reverse()) await runStep(step, perStep);
      clearTimeout(force);
      exit(code);
    })();
    return running;
  }

  /** @param {NodeJS.EventEmitter} [target] */
  function installSignalHandlers(target = process) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
      try { target.on(signal, () => { void shutdown(signal); }); } catch {}
    }
    // Electron 主进程通过 IPC 发 shutdown：Windows 上 kill("SIGTERM") 等同于强杀，不会触发信号处理。
    target.on?.("message", (/** @type {any} */ message) => {
      if (message && message.type === "shutdown") void shutdown("ipc");
    });
    // 由桌面端托管时，父进程意外退出会断开 IPC；此时一并退出，避免孤儿网关继续占用单实例锁。
    if (/** @type {any} */ (target).connected) target.once?.("disconnect", () => { void shutdown("parent disconnected"); });
  }

  return { register, shutdown, installSignalHandlers, get stopping() { return Boolean(running); } };
}
