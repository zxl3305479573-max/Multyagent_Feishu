import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkWriteAllowed, isDeleteCommand, isDenied, isWithin, resolvePath, resolveWritePaths } from "../src/policy.js";

const cwd = process.cwd();

test("policy config scopes each role to its owned project paths", async () => {
  const config = JSON.parse(await readFile(new URL("../config/policy.json", import.meta.url), "utf8"));
  assert.deepEqual(config.agents.project_manager.writePaths, ["workspace/{project}/artifacts"]);
  assert.deepEqual(config.agents.architect.writePaths, ["workspace/{project}/artifacts"]);
  assert.deepEqual(config.agents.frontend_developer.writePaths, [
    "workspace/{project}/frontend",
    "workspace/{project}/artifacts",
  ]);
  assert.deepEqual(config.agents.backend_developer.writePaths, [
    "workspace/{project}/backend",
    "workspace/{project}/artifacts",
  ]);
  assert.deepEqual(config.agents.tester.writePaths, ["workspace/{project}/artifacts"]);
  assert.deepEqual(config.agents.auditor.writePaths, ["workspace/{project}/artifacts"]);
});

test("白名单内放行", () => {
  const r = checkWriteAllowed(cwd, "workspace/frontend/login.vue", { writePaths: ["workspace/frontend"] });
  assert.equal(r.allowed, true);
});

test("白名单外拒绝", () => {
  const r = checkWriteAllowed(cwd, "src/index.js", { writePaths: ["workspace/frontend"] });
  assert.equal(r.allowed, false);
});

test("绝对路径同样校验", () => {
  const abs = resolve(cwd, "workspace/frontend/a.txt");
  assert.equal(checkWriteAllowed(cwd, abs, { writePaths: ["workspace/frontend"] }).allowed, true);
  const absOut = resolve(cwd, "workspace/backend/b.txt");
  assert.equal(checkWriteAllowed(cwd, absOut, { writePaths: ["workspace/frontend"] }).allowed, false);
});

test("../ 穿越被拒绝", () => {
  const r = checkWriteAllowed(cwd, "workspace/frontend/../../src/index.js", { writePaths: ["workspace/frontend"] });
  assert.equal(r.allowed, false);
});

test("deny 优先于 allow", () => {
  const r = checkWriteAllowed(cwd, "workspace/frontend/legacy/x.js", {
    writePaths: ["workspace/frontend"],
    denyPaths: ["workspace/frontend/legacy"],
  });
  assert.equal(r.allowed, false);
});

test("无效路径拒绝", () => {
  assert.equal(checkWriteAllowed(cwd, null, { writePaths: ["workspace/frontend"] }).allowed, false);
  assert.equal(checkWriteAllowed(cwd, "", { writePaths: ["workspace/frontend"] }).allowed, false);
});

test("无 writePaths 时默认放行（deny 仍生效）", () => {
  assert.equal(checkWriteAllowed(cwd, "anything/here.txt", {}).allowed, true);
  assert.equal(checkWriteAllowed(cwd, "anything/.env", { denyPaths: [".env"] }).allowed, true); // .env 是文件不是目录，目录语义不含
});

test("isWithin / isDenied 边界", () => {
  const abs = resolvePath(cwd, "workspace/frontend");
  assert.equal(isWithin(cwd, abs, ["workspace/frontend"]), true);
  assert.equal(isDenied(cwd, abs, ["workspace/frontend"]), true);
});

test("resolveWritePaths 替换 {project} 占位符", () => {
  assert.deepEqual(resolveWritePaths(["workspace/{project}/frontend"], "phone-login"), ["workspace/phone-login/frontend"]);
  assert.deepEqual(resolveWritePaths(["workspace/{project}"], undefined), ["workspace/default"]);
  assert.deepEqual(resolveWritePaths(["workspace"], "phone-login"), ["workspace"]);
  assert.deepEqual(resolveWritePaths(undefined, "x"), []);
});

test("isDeleteCommand 识别删除类命令", () => {
  assert.equal(isDeleteCommand("rm -rf workspace/x"), true);
  assert.equal(isDeleteCommand("rmdir foo"), true);
  assert.equal(isDeleteCommand("unlink a.txt"), true);
  assert.equal(isDeleteCommand("del a.txt"), true);
  assert.equal(isDeleteCommand("Remove-Item -Recurse -Force x"), true);
  assert.equal(isDeleteCommand("git clean -fd"), true);
  assert.equal(isDeleteCommand("npm rm left-pad"), true);
});

test("isDeleteCommand 放行创建/写入/构建类命令", () => {
  assert.equal(isDeleteCommand("npm install"), false);
  assert.equal(isDeleteCommand("npm run build"), false);
  assert.equal(isDeleteCommand("npm test"), false);
  assert.equal(isDeleteCommand("git status"), false);
  assert.equal(isDeleteCommand("git add ."), false);
  assert.equal(isDeleteCommand("mkdir -p a/b"), false);
  assert.equal(isDeleteCommand("echo hi > a.txt"), false);
});
