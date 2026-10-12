const { spawn } = require("node:child_process");

// 网关子进程管理。
// 停止时优先通过 IPC 请求网关优雅退出（关闭长连接、刷新任务快照、释放锁）；
// Windows 上 kill("SIGTERM") 等同于强制结束进程，不会触发网关的清理逻辑，所以只作兜底。
function createGatewayProcess({ spawnImpl = spawn, entry, cwd, env = {}, log = console, gracefulTimeoutMs = 8000, killTimeoutMs = 5000 } = {}) {
  if (!entry || !cwd) throw new TypeError("gateway process requires entry and cwd");
  let child = null;
  return {
    start() {
      if (child && !child.killed) return child;
      child = spawnImpl(process.execPath, [entry], { cwd, env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: true });
      const current = child;
      current.once?.("error", (error) => log.error?.(`[desktop] gateway failed: ${error.message}`));
      current.once?.("exit", (code, signal) => { if (code && code !== 0) log.error?.(`[desktop] gateway exited (${code || signal})`); if (child === current) child = null; });
      return current;
    },
    async stop() {
      const current = child; if (!current) return;
      child = null;
      if (current.exitCode !== null && current.exitCode !== undefined) return;
      await new Promise((resolve) => {
        let settled = false;
        let killTimer = null;
        let graceTimer = null;
        const finish = () => { if (settled) return; settled = true; clearTimeout(graceTimer); clearTimeout(killTimer); resolve(); };
        const forceKill = () => {
          try { current.kill?.("SIGKILL"); } catch {}
          finish();
        };
        const terminate = () => {
          try { current.kill?.("SIGTERM"); } catch { finish(); return; }
          killTimer = setTimeout(forceKill, killTimeoutMs);
        };
        current.once?.("exit", finish);
        if (current.connected && typeof current.send === "function") {
          try {
            current.send({ type: "shutdown" });
            graceTimer = setTimeout(terminate, gracefulTimeoutMs);
            return;
          } catch {}
        }
        terminate();
      });
    },
    async restart(nextEnv = env) { await this.stop(); env = nextEnv; return this.start(); },
    get child() { return child; },
  };
}

module.exports = { createGatewayProcess };
