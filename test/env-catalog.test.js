import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildEnvCatalog, catalogFields, isSecretKey } from "../src/env-catalog.cjs";
import { roleConfig } from "../src/role-config.cjs";

// 只在开发时使用、不属于运行配置的变量。
const NOT_SETTINGS = new Set([
  "ELECTRON_RENDERER_URL",
  // 仅用于隔离的桌面 E2E 启动，不暴露给最终用户做运行配置。
  "PI_DESKTOP_E2E",
  "PI_DESKTOP_E2E_USER_DATA",
]);

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:c|m)?js$/.test(name) ? [path] : [];
  });
}

test("every environment variable read by the app appears in the settings catalog", () => {
  const keys = new Set(catalogFields().map((field) => field.key));
  const used = new Set();
  for (const file of [...sourceFiles("src"), ...sourceFiles("desktop/electron"), ...sourceFiles("scripts")]) {
    for (const match of readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) used.add(match[1]);
  }
  const missing = [...used].filter((key) => !keys.has(key) && !NOT_SETTINGS.has(key));
  assert.deepEqual(missing, [], `运行设置缺少这些环境变量：${missing.join(", ")}`);
});

test("every role contributes its Feishu credentials as secrets", () => {
  for (const role of roleConfig().roles) {
    assert.equal(isSecretKey(role.feishu.appIdEnv), true);
    assert.equal(isSecretKey(role.feishu.appSecretEnv), true);
  }
  assert.equal(isSecretKey("DEEPSEEK_API_KEY"), true);
  assert.equal(isSecretKey("PI_AGENT_API_KEY"), true);
  assert.equal(isSecretKey("PI_AGENT_MODEL"), false);
});

test("catalog keys are unique and fields are well formed", () => {
  const fields = catalogFields(buildEnvCatalog());
  const keys = fields.map((field) => field.key);
  assert.equal(new Set(keys).size, keys.length, "重复的配置项");
  for (const field of fields) {
    assert.match(field.key, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(field.label);
    if (field.type === "select" || field.type === "roles") assert.ok(field.options?.length, `${field.key} 缺少选项`);
    if (field.type === "boolean") assert.ok(field.trueValue !== undefined && field.falseValue !== undefined);
    if (field.default && field.type === "select" && !field.allowCustom) assert.ok(field.options.some(([value]) => value === field.default));
  }
});
