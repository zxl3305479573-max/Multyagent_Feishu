import { spawn as defaultSpawn } from "node:child_process";
import { loadMcpConfig, normalizeMcpServer, saveMcpConfig } from "./config.js";

const PROTOCOL_VERSION = "2024-11-05";
const MAX_LINE = 1024 * 1024;
const MCP_ENV_ALLOWLIST = ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL"];

function errorText(error) { return String(error?.message || error).slice(0, 500); }
function toolName(serverId, name) {
  const suffix = String(name || "tool").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 48) || "tool";
  return `mcp_${serverId}_${suffix}`;
}

function resultText(result) {
  if (Array.isArray(result?.content)) return result.content.map((item) => item?.text || item?.type || "").filter(Boolean).join("\n");
  return JSON.stringify(result ?? {});
}

class McpStdioClient {
  constructor(server, { spawn = defaultSpawn, log = console, envSource = process.env, timeoutMs = 10_000 } = {}) {
    this.server = server;
    this.spawn = spawn;
    this.log = log;
    this.envSource = envSource;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
  }

  async start() {
    if (this.child) return this.tools;
    const env = Object.fromEntries(MCP_ENV_ALLOWLIST.filter((key) => this.envSource[key] !== undefined).map((key) => [key, this.envSource[key]]));
    for (const [key, envName] of Object.entries(this.server.env || {})) {
      if (this.envSource[envName] !== undefined) env[key] = this.envSource[envName];
    }
    const child = this.spawn(this.server.command, this.server.args || [], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => this.#read(chunk));
    child.stderr?.on("data", () => {});
    child.once("error", (error) => this.#fail(error));
    child.once("exit", (code, signal) => {
      this.#fail(new Error(`MCP server exited (code=${code}, signal=${signal || ""})`));
      if (this.owner?.clients.get(this.server.id) === this) {
        this.owner.clients.delete(this.server.id);
        this.owner.statuses.set(this.server.id, { status: "error", error: `MCP 服务已退出（code=${code}, signal=${signal || ""}）`, toolsCount: 0 });
        this.owner.version += 1;
      }
    });
    try {
      await this.#request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "multyagent-feishu", version: "0.1.0" } });
      this.#notify("notifications/initialized", {});
      const response = await this.#request("tools/list", {});
      this.tools = Array.isArray(response?.tools) ? response.tools.filter((tool) => tool?.name) : [];
      return this.tools;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  #read(chunk) {
    this.buffer += chunk.toString();
    if (this.buffer.length > MAX_LINE * 2) return this.#fail(new Error("MCP response buffer exceeded limit"));
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line || line.length > MAX_LINE) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const pending = message.id === undefined ? null : this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "MCP JSON-RPC error"));
      else pending.resolve(message.result);
    }
  }

  #fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.child) this.child = null;
  }

  #request(method, params) {
    if (!this.child?.stdin) return Promise.reject(new Error("MCP server is not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  #notify(method, params) {
    try { this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); } catch {}
  }

  call(name, args) { return this.#request("tools/call", { name, arguments: args || {} }); }

  async stop() {
    const child = this.child;
    this.child = null;
    this.tools = [];
    this.#fail(new Error("MCP server stopped"));
    if (!child) return;
    try { child.stdin?.end(); } catch {}
    try { child.kill("SIGTERM"); } catch {}
  }
}

export class McpService {
  constructor({ file = process.env.PI_MCP_CONFIG_FILE || "runtime/mcp.json", spawn = defaultSpawn, log = console, envSource = process.env } = {}) {
    this.file = file;
    this.spawn = spawn;
    this.log = log;
    this.envSource = envSource;
    this.config = { version: 1, servers: [] };
    this.clients = new Map();
    this.statuses = new Map();
    this.version = 0;
    this.loaded = false;
  }

  async load() {
    if (!this.loaded) {
      this.config = await loadMcpConfig(this.file);
      this.loaded = true;
    }
    return this.config;
  }

  async startAll() {
    await this.load();
    for (const server of this.config.servers) if (server.enabled && server.trusted) await this.connect(server.id).catch((error) => this.log.warn?.(`[mcp:${server.id}] ${errorText(error)}`));
    return this.list();
  }

  async connect(id) {
    await this.load();
    const server = this.config.servers.find((item) => item.id === id);
    if (!server) throw new Error("找不到 MCP server");
    if (!server.trusted) throw new Error("MCP server must be explicitly trusted before connecting");
    if (!server.enabled) throw new Error("MCP server must be enabled before connecting");
    await this.disconnect(id);
    const client = new McpStdioClient(server, { spawn: this.spawn, log: this.log, envSource: this.envSource });
    client.owner = this;
    this.clients.set(id, client);
    this.statuses.set(id, { status: "connecting", error: null });
    try {
      const tools = await client.start();
      this.statuses.set(id, { status: "connected", error: null, toolsCount: tools.length });
      this.version += 1;
      return this.describe(server);
    } catch (error) {
      this.clients.delete(id);
      this.statuses.set(id, { status: "error", error: errorText(error), toolsCount: 0 });
      throw error;
    }
  }

  async disconnect(id) {
    const client = this.clients.get(id);
    this.clients.delete(id);
    if (client) await client.stop();
    if (this.statuses.has(id)) this.statuses.set(id, { status: "disconnected", error: null, toolsCount: 0 });
    this.version += 1;
  }

  async stopAll() { for (const id of [...this.clients.keys()]) await this.disconnect(id); }

  describe(server) {
    const status = this.statuses.get(server.id) || { status: server.enabled && server.trusted ? "disconnected" : "disabled", error: null, toolsCount: 0 };
    const client = this.clients.get(server.id);
    return {
      ...server,
      env: { ...(server.env || {}) },
      status: status.status,
      error: status.error,
      tools: (client?.tools || []).map((tool) => ({ name: tool.name, description: String(tool.description || ""), inputSchema: tool.inputSchema || {} })),
    };
  }

  async list() { await this.load(); return { file: this.file, servers: this.config.servers.map((server) => this.describe(server)) }; }

  async save(input = {}) {
    await this.load();
    const server = normalizeMcpServer(input);
    const previous = this.config.servers.find((item) => item.id === server.id);
    if (previous && previous.id !== server.id) await this.disconnect(previous.id);
    this.config.servers = [...this.config.servers.filter((item) => item.id !== server.id), server].sort((a, b) => a.id.localeCompare(b.id));
    await saveMcpConfig(this.file, this.config);
    await this.disconnect(server.id);
    if (server.enabled && server.trusted) await this.connect(server.id).catch(() => {});
    return this.describe(server);
  }

  async remove(id) {
    await this.load();
    const before = this.config.servers.length;
    await this.disconnect(id);
    this.config.servers = this.config.servers.filter((server) => server.id !== id);
    if (this.config.servers.length === before) throw new Error("找不到 MCP server");
    await saveMcpConfig(this.file, this.config);
    return { removed: true };
  }

  async setEnabled(id, enabled) {
    await this.load();
    const server = this.config.servers.find((item) => item.id === id);
    if (!server) throw new Error("找不到 MCP server");
    if (enabled === true && !server.trusted) throw new Error("请先在技能中心确认信任该 MCP 服务");
    server.enabled = enabled === true;
    await saveMcpConfig(this.file, this.config);
    if (server.enabled) await this.connect(id).catch(() => {}); else await this.disconnect(id);
    return this.describe(server);
  }

  toolsForRole(role) {
    const result = [];
    for (const server of this.config.servers) {
      if (!server.enabled || !server.trusted || (server.roles.length && !server.roles.includes(role))) continue;
      const client = this.clients.get(server.id);
      for (const definition of client?.tools || []) result.push({ server, definition, name: toolName(server.id, definition.name) });
    }
    return result;
  }

  async call(serverId, name, args) {
    const client = this.clients.get(serverId);
    if (!client) throw new Error("MCP server 未连接");
    return client.call(name, args);
  }
}

export { resultText, toolName };
