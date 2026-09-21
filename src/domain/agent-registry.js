import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const REQUIRED_FIELDS = [
  "key",
  "display_name",
  "runtime",
  "profile",
  "policy",
  "workspace",
  "session_dir",
  "max_concurrent_tasks",
  "max_turns",
  "max_runtime_seconds",
];

export function validateAgentRegistry(registry) {
  const errors = [];
  if (!registry || !Array.isArray(registry.agents)) return { valid: false, errors: ["agents"] };
  const keys = new Set();
  for (const [index, agent] of registry.agents.entries()) {
    for (const field of REQUIRED_FIELDS) {
      if (agent?.[field] === undefined || agent[field] === null || agent[field] === "") {
        errors.push(`agents[${index}].${field}`);
      }
    }
    if (agent?.key && keys.has(agent.key)) errors.push(`agents[${index}].key.duplicate`);
    if (agent?.key) keys.add(agent.key);
    for (const field of ["max_concurrent_tasks", "max_turns", "max_runtime_seconds"]) {
      if (agent?.[field] !== undefined && (!Number.isInteger(agent[field]) || agent[field] <= 0)) {
        errors.push(`agents[${index}].${field}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function loadAgentRegistry(file = new URL("../../config/agent-registry.json", import.meta.url)) {
  const registry = JSON.parse(await readFile(file, "utf8"));
  const result = validateAgentRegistry(registry);
  if (!result.valid) throw new Error(`Agent registry invalid: ${result.errors.join(", ")}`);
  return registry;
}

export function resolveRegistryPath(registryFile, relativePath) {
  return resolve(dirname(registryFile), relativePath);
}
