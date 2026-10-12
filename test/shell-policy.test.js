import test from "node:test";
import assert from "node:assert/strict";
import { checkShellCommand, isDeleteCommand, redirectTargets, splitShellSegments } from "../src/policy.js";
import { createPolicyFactory } from "../src/pi-agent.js";

const cwd = process.cwd();
const dev = { shellMode: "write", writePaths: ["workspace/student/frontend", "workspace/student/artifacts"] };
const reader = { shellMode: "readonly", writePaths: ["workspace/student/artifacts"] };

test("shell segments and redirect targets are parsed", () => {
  assert.deepEqual(splitShellSegments("npm test && echo 'a;b' > x.txt | tee y"), ["npm test", "echo 'a;b' > x.txt", "tee y"]);
  assert.deepEqual(redirectTargets("npm test 2>&1 > out.log >> \"a b.txt\" 2> /dev/null"), ["out.log", "a b.txt"]);
});

test("plain read-only commands stay allowed", () => {
  for (const command of ["npm test", "git status", "git diff HEAD~1", "ls workspace/student", "npm test 2>&1", "node --test test/a.test.js > nul"]) {
    assert.equal(checkShellCommand(cwd, command, reader).allowed, true, command);
  }
});

test("redirects and mutating commands must stay inside write paths", () => {
  assert.equal(checkShellCommand(cwd, "echo hi > workspace/student/frontend/a.txt", dev).allowed, true);
  assert.equal(checkShellCommand(cwd, "echo hi > src/index.js", dev).allowed, false);
  assert.equal(checkShellCommand(cwd, "cp src/a.js ../../outside.js", dev).allowed, false);
  assert.equal(checkShellCommand(cwd, "Set-Content -Path config/policy.json -Value x", dev).allowed, false);
  assert.equal(checkShellCommand(cwd, "sed -i s/a/b/ src/gateway.js", dev).allowed, false);
  assert.equal(checkShellCommand(cwd, "mkdir workspace/student/frontend/components", dev).allowed, true);
  assert.equal(checkShellCommand(cwd, "cd .. && echo x > workspace/student/frontend/a", dev).allowed, false);
  assert.equal(checkShellCommand(cwd, "echo x > $env:TEMP/a", dev).allowed, false);
});

test("inline interpreters and dynamic execution are refused", () => {
  for (const command of [
    "node -e \"require('fs').writeFileSync('src/x.js','')\"",
    "python -c 'import os'",
    "powershell -Command Remove-Item x",
    "pwsh -EncodedCommand AAAA",
    "bash -c 'echo > src/x'",
    "cmd /c del x",
    "iex (gc script.ps1)",
    "eval \"$CMD\"",
  ]) assert.equal(checkShellCommand(cwd, command, dev).allowed, false, command);
});

test("read-only roles cannot mutate files, git state or dependencies", () => {
  assert.equal(checkShellCommand(cwd, "npm test > workspace/student/artifacts/test.log", reader).allowed, true);
  assert.equal(checkShellCommand(cwd, "cp a workspace/student/artifacts/b", reader).allowed, false);
  assert.equal(checkShellCommand(cwd, "git commit -am x", reader).allowed, false);
  assert.equal(checkShellCommand(cwd, "npm install left-pad", reader).allowed, false);
  assert.equal(checkShellCommand(cwd, "ls", { shellMode: "none" }).allowed, false);
});

test("delete detection covers scripted deletes", () => {
  for (const command of ["git rm src/a.js", "find . -name '*.js' -delete", "ri -Recurse x", "[System.IO.File]::Delete('a')"]) {
    assert.equal(isDeleteCommand(command), true, command);
  }
  assert.equal(isDeleteCommand("npm run format"), false);
});

test("policy extension applies shell write checks per role", async () => {
  const handlerFor = (key) => {
    let onToolCall;
    createPolicyFactory({ key }, () => "student")({ on(name, handler) { if (name === "tool_call") onToolCall = handler; } });
    return onToolCall;
  };
  const tester = handlerFor("tester");
  assert.equal((await tester({ toolName: "bash", input: { command: "npm test" } }, { cwd }))?.block, undefined);
  assert.equal((await tester({ toolName: "bash", input: { command: "echo x > workspace/student/frontend/app.js" } }, { cwd }))?.block, true);
  const frontend = handlerFor("frontend_developer");
  assert.equal((await frontend({ toolName: "bash", input: { command: "echo x > workspace/student/frontend/app.js" } }, { cwd }))?.block, undefined);
  assert.equal((await frontend({ toolName: "bash", input: { command: "echo x > workspace/student/backend/api.js" } }, { cwd }))?.block, true);
  const noProject = (() => {
    let onToolCall;
    createPolicyFactory({ key: "frontend_developer" }, () => null)({ on(name, handler) { if (name === "tool_call") onToolCall = handler; } });
    return onToolCall;
  })();
  assert.equal((await noProject({ toolName: "bash", input: { command: "echo x > workspace/default/frontend/a" } }, { cwd }))?.block, true);
});
