import { readJsonFile, writeFileAtomic } from "../atomic-file.cjs";

const ID = /^[a-z][a-z0-9_-]{1,63}$/;

function text(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function stringList(value, max = 40) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => text(item, 1000)).filter(Boolean))].slice(0, max);
}

function envRefs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, envName]) => [text(key, 120), text(envName, 120)])
    .filter(([key, envName]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)));
}

export function normalizeMcpServer(input = {}, { existingId = "" } = {}) {
  const id = text(input.id || existingId, 64).toLowerCase();
  if (!ID.test(id)) throw new Error("MCP server id 必须是 2-64 位小写字母、数字、下划线或连字符");
  const transport = "stdio";
  const command = text(input.command, 1000);
  if (transport === "stdio" && !command) throw new Error("stdio MCP server 必须填写启动命令");
  return {
    id,
    name: text(input.name || id, 160),
    transport,
    command,
    args: stringList(input.args, 32),
    env: envRefs(input.env),
    roles: stringList(input.roles, 40),
    enabled: input.enabled !== false,
    trusted: input.trusted === true,
  };
}

export function normalizeMcpConfig(input) {
  const servers = Array.isArray(input?.servers) ? input.servers : [];
  const seen = new Set();
  return {
    version: 1,
    servers: servers.map((server) => normalizeMcpServer(server)).filter((server) => {
      if (seen.has(server.id)) return false;
      seen.add(server.id);
      return true;
    }),
  };
}

export async function loadMcpConfig(file) {
  return normalizeMcpConfig(await readJsonFile(file, { fallback: () => ({ version: 1, servers: [] }), onCorrupt: "throw" }));
}

export async function saveMcpConfig(file, config) {
  const normalized = normalizeMcpConfig(config);
  await writeFileAtomic(file, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export { ID as MCP_SERVER_ID };
