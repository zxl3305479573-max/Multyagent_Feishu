import test from "node:test";
import assert from "node:assert/strict";
import { loadAgentRegistry, validateAgentRegistry } from "../src/domain/agent-registry.js";

test("agent registry contains complete runtime metadata for every role", async () => {
  const registry = await loadAgentRegistry();
  assert.equal(registry.agents.length, 6);
  assert.equal(validateAgentRegistry(registry).valid, true);
  for (const agent of registry.agents) {
    assert.match(agent.profile, /^profiles\//);
    assert.match(agent.policy, /^policies\//);
    assert.equal(agent.runtime, "pi");
  }
});

test("agent registry rejects duplicate keys and invalid budgets", () => {
  const result = validateAgentRegistry({
    agents: [{
      key: "x",
      display_name: "x",
      runtime: "pi",
      profile: "profiles/x.md",
      policy: "policies/x.json",
      workspace: "workspace/{project}",
      session_dir: "runtime/sessions/x",
      max_concurrent_tasks: 0,
      max_turns: 1,
      max_runtime_seconds: 1,
    }, {
      key: "x",
      display_name: "x2",
      runtime: "pi",
      profile: "profiles/x2.md",
      policy: "policies/x2.json",
      workspace: "workspace/{project}",
      session_dir: "runtime/sessions/x2",
      max_concurrent_tasks: 1,
      max_turns: 1,
      max_runtime_seconds: 1,
    }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("agents[0].max_concurrent_tasks"));
  assert.ok(result.errors.includes("agents[1].key.duplicate"));
});
