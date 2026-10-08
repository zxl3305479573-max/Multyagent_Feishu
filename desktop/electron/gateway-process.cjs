const { spawn } = require("node:child_process");

function createGatewayProcess({ spawnImpl = spawn, entry, cwd, env = {}, log = console } = {}) {
  if (!entry || !cwd) throw new TypeError("gateway process requires entry and cwd");
  let child = null;
  return {
    start() {
      if (child && !child.killed) return child;
      child = spawnImpl(process.execPath, [entry], { cwd, env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit", windowsHide: true });
      child.once?.("error", (error) => log.error?.(`[desktop] gateway failed: ${error.message}`));
      child.once?.("exit", (code, signal) => { if (code && code !== 0) log.error?.(`[desktop] gateway exited (${code || signal})`); child = null; });
      return child;
    },
    async stop() {
      const current = child; if (!current) return;
      child = null;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { try { current.kill?.("SIGKILL"); } catch {} finish(); }, 5000);
        current.once?.("exit", finish);
        try { current.kill?.("SIGTERM"); } catch { finish(); }
        if (current.exitCode !== null && current.exitCode !== undefined) finish();
      });
    },
    async restart(nextEnv = env) { await this.stop(); env = nextEnv; return this.start(); },
    get child() { return child; },
  };
}

module.exports = { createGatewayProcess };
