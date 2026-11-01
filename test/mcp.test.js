import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, normalizeMcpServer, saveMcpConfig } from "../src/mcp/config.js";
import { McpService } from "../src/mcp/service.js";
import { checkMcpToolCall } from "../src/agent/policy-gate.js";

test("MCP config saves only environment variable references", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "mcp.json");
  await saveMcpConfig(file, { servers: [{ id: "files", name: "文件", command: "node", args: ["server.js"], env: { TOKEN: "MCP_TOKEN" }, trusted: true }] });
  const loaded = await loadMcpConfig(file);
  assert.deepEqual(loaded.servers[0].env, { TOKEN: "MCP_TOKEN" });
  assert.equal((await readFile(file, "utf8")).includes("secret-value"), false);
  assert.throws(() => normalizeMcpServer({ id: "bad id", command: "node" }), /server id/);
});

test("MCP policy rejects credentials and out-of-bounds paths", () => {
  assert.equal(checkMcpToolCall("mcp_demo_search", { query: "ok" }), null);
  assert.match(checkMcpToolCall("mcp_demo_call", { api_key: "should-not-pass" })?.reason || "", /密钥字段/);
  assert.match(checkMcpToolCall("mcp_demo_read", { path: "../.env" }, { cwd: "D:/workspace/demo", allowedPaths: ["workspace/demo/src"] })?.reason || "", /敏感文件/);
  assert.match(checkMcpToolCall("mcp_demo_read", { path: "D:/workspace/other/a.txt" }, { cwd: "D:/workspace/demo", allowedPaths: ["D:/workspace/demo/src"] })?.reason || "", /允许范围/);
});

test("MCP stdio lifecycle discovers tools and calls JSON-RPC server", async (t) => {
  const calls = [];
  const listeners = {};
  const tempRoot = await mkdtemp(join(tmpdir(), "mcp-service-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const child = {
    stdin: { write(line) {
      const request = JSON.parse(line);
      calls.push(request);
      if (request.id) {
        const result = request.method === "initialize" ? { protocolVersion: "2024-11-05" } : request.method === "tools/list" ? { tools: [{ name: "echo", description: "回声", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: "ok" }] };
        queueMicrotask(() => listeners.data?.(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)));
      }
    }, end() {} },
    stdout: { on(type, handler) { listeners[type] = handler; } },
    stderr: { on() {} },
    once(type, handler) { listeners[type] = handler; },
    kill() {},
  };
  const service = new McpService({ file: join(tempRoot, "mcp.json"), spawn: () => child });
  t.after(() => service.stopAll());
  await saveMcpConfig(service.file, { servers: [{ id: "demo", name: "演示", command: "demo", env: {}, roles: ["tester"], trusted: true }] });
  await service.startAll();
  assert.equal((await service.list()).servers[0].status, "connected");
  assert.equal(service.toolsForRole("tester")[0].name, "mcp_demo_echo");
  assert.equal((await service.call("demo", "echo", { text: "x" })).content[0].text, "ok");
  assert.equal(calls.filter((call) => call.method === "tools/call").length, 1);
});

test("MCP connect cannot bypass explicit trust confirmation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-untrusted-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = new McpService({ file: join(dir, "mcp.json"), spawn: () => { throw new Error("must not spawn"); } });
  await saveMcpConfig(service.file, { servers: [{ id: "untrusted", command: "server", trusted: false }] });
  await assert.rejects(service.connect("untrusted"), /explicitly trusted/);
  assert.equal(service.clients.size, 0);
});
