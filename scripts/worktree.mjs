#!/usr/bin/env node
import { parseArgs } from "../src/agent-cli.js";
import {
  applyWorktreePatch,
  collectWorktreeChanges,
  listWorktrees,
  removeWorktree,
} from "../src/runtime/worktree.js";

function output(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = code;
}

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  const root = options.root || process.cwd();
  if (command === "list") {
    output({ status: "passed", worktrees: await listWorktrees({ root }) });
  } else if (command === "collect") {
    const result = await collectWorktreeChanges({
      root,
      agentKey: options.agent,
      taskId: options.task,
      artifactsDir: options.artifacts || null,
    });
    output({ status: "passed", ...result });
  } else if (command === "apply") {
    const result = await applyWorktreePatch({
      root,
      agentKey: options.agent,
      taskId: options.task,
      confirm: options.confirm === true,
    });
    output({ status: result.applied ? "passed" : "failed", ...result }, result.applied ? 0 : 1);
  } else if (command === "cleanup") {
    await removeWorktree({ root, agentKey: options.agent, taskId: options.task, force: options.force === true });
    output({ status: "passed", removed: true });
  } else {
    throw new Error("usage: worktree <list|collect|apply|cleanup> ...");
  }
} catch (error) {
  output({ status: "failed", error: error.message }, 1);
}
