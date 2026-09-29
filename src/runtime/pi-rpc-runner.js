import { spawn as defaultSpawn } from "node:child_process";

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

export class PiRpcRunner {
  constructor({ spawn = defaultSpawn, command = process.execPath, args = [], log = () => {} } = {}) {
    this.spawn = spawn;
    this.command = command;
    this.args = args;
    this.log = log;
  }

  async run(prompt, { cwd, sessionDir, timeoutMs = 900_000, env = {}, onEvent, args: extraArgs = [] } = {}) {
    const args = [...this.args, ...extraArgs];
    if (sessionDir) args.push("--session-dir", sessionDir);
    const child = this.spawn(this.command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let settled = false;
    let stdoutError;
    let stderr = "";
    let output = "";
    let timedOut = false;

    const emit = (event) => {
      events.push(event);
      this.log({ type: "pi_event", event });
      onEvent?.(event);
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        output += event.assistantMessageEvent.delta || "";
      }
      if (event.type === "agent_settled") settled = true;
    };

    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { emit(JSON.parse(line)); } catch { this.log({ type: "pi_protocol_line", line }); }
      }
    });

    const exit = new Promise((resolve, reject) => {
      child.once("error", (error) => { stdoutError = error; reject(error); });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);

    try {
      child.stdin.write(`${JSON.stringify({ type: "prompt", message: String(prompt || "") })}\n`);
      const result = await exit;
      if (buffer.trim()) {
        try { emit(JSON.parse(buffer.trim())); } catch { this.log({ type: "pi_protocol_line", line: buffer.trim() }); }
      }
      if (!settled) {
        if (timedOut) throw new Error(`Pi RPC timed out after ${timeoutMs}ms`);
        const reason = stdoutError?.message || `Pi RPC exited before agent_settled (code=${result.code}, signal=${result.signal})`;
        throw new Error(`${reason}${stderr ? `: ${stderr.trim()}` : ""}`);
      }
      return { text: output.trim(), events, stderr, exit: result };
    } catch (error) {
      if (error?.code === "ERR_STREAM_WRITE_AFTER_END") throw asError(error);
      if (String(error?.message || "").includes("before agent_settled")) throw error;
      throw new Error(`${asError(error).message}${stderr ? `: ${stderr.trim()}` : ""}`);
    } finally {
      clearTimeout(timer);
      if (!settled) {
        try { child.kill("SIGKILL"); } catch {}
      }
    }
  }
}

export function defaultPiRpcRunner(options = {}) {
  return new PiRpcRunner({
    command: process.env.PI_RPC_COMMAND || "pi",
    args: ["--mode", "rpc"],
    ...options,
  });
}
