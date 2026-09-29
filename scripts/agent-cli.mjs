#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { executeAgentCli, parseArgs, parseJson } from "../src/agent-cli.js";

function output(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = code;
}

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "test") {
    if (options.command || options.args || options.args_json) {
      throw new Error("agent-cli test does not accept --command/--args; it only runs the repository test suite");
    }
    const result = await executeAgentCli("test", { args: ["--test", "test"], cwd: options.cwd || process.cwd() });
    output(result, result.status === "passed" ? 0 : 1);
  } else if (command === "task-status") {
    output(await executeAgentCli("task-status", { taskId: options.task_id, chatId: options.chat_id, taskFile: options.task_file }));
  } else if (command === "validate-delivery") {
    const paths = options.artifacts ? parseJson(options.artifacts, "artifacts") : [];
    const result = await executeAgentCli("validate-delivery", { root: options.root, taskId: options.task_id, projectName: options.project, agent: options.agent, artifactPaths: paths });
    output(result, result.valid ? 0 : 1);
  } else if (command === "render-diagram") {
    const spec = parseJson(await readFile(options.input, "utf8"), "diagram input");
    output(await executeAgentCli("render-diagram", { root: options.root, taskId: options.task_id, projectName: options.project, spec, format: options.format || "png" }));
  } else if (command === "bitable") {
    const result = await executeAgentCli("bitable", { action: options.action, options });
    output(result, result.status === "passed" ? 0 : 1);
  } else {
    throw new Error("usage: agent-cli <test|task-status|validate-delivery|render-diagram|bitable> ...");
  }
} catch (error) {
  output({ status: "failed", error: error.message }, 1);
}
