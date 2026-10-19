import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { applyRuntimeConfig, buildCustomModelsConfig, currentRuntimeSettings, modelConfigEnv, prepareModelConfig, runtimeConfigPayload, selectedModel } from "../src/model-config.js";

const customEnv = {
  PI_AGENT_PROVIDER: "ollama",
  PI_AGENT_MODEL: "qwen2.5-coder:7b",
  PI_AGENT_BASE_URL: "http://localhost:11434/v1",
  PI_AGENT_API_TYPE: "openai-completions",
  PI_AGENT_API_KEY: "local-secret",
  PI_AGENT_MODEL_NAME: "Qwen Coder Local",
  PI_AGENT_CONTEXT_WINDOW: "131072",
  PI_AGENT_MAX_TOKENS: "16384",
  PI_AGENT_MODEL_REASONING: "false",
};

test("selectedModel keeps Pi defaults consistent across embedded and RPC runtimes", () => {
  assert.deepEqual(selectedModel({}), { provider: "deepseek", model: "deepseek-flash" });
  assert.deepEqual(selectedModel({ PI_AGENT_PROVIDER: "company", PI_AGENT_MODEL: "coder-1" }), { provider: "company", model: "coder-1" });
  assert.deepEqual(currentRuntimeSettings({ PI_AGENT_PROVIDER: "company", PI_AGENT_MODEL: "coder-1", PI_AGENT_THINKING: "high" }), { provider: "company", model: "coder-1", thinking: "high" });
});

test("runtime config exposes the selected provider models and applies a switch", () => {
  const runtime = {
    getProviders: () => [{ id: "openai", name: "OpenAI" }, { id: "local", name: "Local" }],
    getModels: (provider) => provider === "openai"
      ? [{ id: "gpt-a", name: "GPT A", reasoning: true, contextWindow: 1000 }, { id: "gpt-b", name: "GPT B" }]
      : [{ id: "coder", name: "Local Coder" }],
    getModel: (provider, model) => runtime.getModels(provider).find((item) => item.id === model),
  };
  const env = { PI_AGENT_PROVIDER: "openai", PI_AGENT_MODEL: "gpt-a", PI_AGENT_THINKING: "off" };
  const initial = runtimeConfigPayload(runtime, { env });
  assert.equal(initial.listingProvider, "openai");
  assert.deepEqual(initial.models.map((item) => item.id), ["gpt-a", "gpt-b"]);
  assert.equal(initial.providers.find((item) => item.id === "local")?.modelCount, 1);

  const switched = applyRuntimeConfig(runtime, { provider: "local", model: "coder", thinking: "medium" }, { env });
  assert.deepEqual({ provider: switched.provider, model: switched.model, thinking: switched.thinking }, { provider: "local", model: "coder", thinking: "medium" });
  assert.deepEqual({ ...env }, { PI_AGENT_PROVIDER: "local", PI_AGENT_MODEL: "coder", PI_AGENT_THINKING: "medium" });
  assert.deepEqual(switched.models.map((item) => item.id), ["coder"]);
  assert.throws(() => applyRuntimeConfig(runtime, { provider: "local", model: "missing" }, { env }), /模型不存在/);
  assert.throws(() => applyRuntimeConfig(runtime, { provider: "local", model: "coder", thinking: "max" }, { env }), /思考强度/);
});

test("custom model settings generate a Pi models.json without embedding the API key", () => {
  const config = buildCustomModelsConfig(customEnv);
  const provider = config.providers.ollama;
  assert.equal(provider.baseUrl, "http://localhost:11434/v1");
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.apiKey, "$PI_AGENT_API_KEY");
  assert.deepEqual(provider.compat, { supportsDeveloperRole: false, supportsReasoningEffort: false });
  assert.deepEqual(provider.models, [{
    id: "qwen2.5-coder:7b",
    name: "Qwen Coder Local",
    input: ["text"],
    reasoning: false,
    contextWindow: 131072,
    maxTokens: 16384,
  }]);
  assert.equal(buildCustomModelsConfig({}), null);
});

test("invalid custom model values fail before Pi starts an agent", () => {
  assert.throws(() => buildCustomModelsConfig({ ...customEnv, PI_AGENT_PROVIDER: "bad/provider" }), /服务商 ID/);
  assert.throws(() => buildCustomModelsConfig({ ...customEnv, PI_AGENT_BASE_URL: "ftp://example.com" }), /http\/https/);
  assert.throws(() => buildCustomModelsConfig({ ...customEnv, PI_AGENT_API_TYPE: "unknown" }), /不支持的 API 类型/);
  assert.throws(() => buildCustomModelsConfig({ ...customEnv, PI_AGENT_CONTEXT_WINDOW: "0" }), /上下文窗口/);
});

test("Pi can resolve a generated custom provider and model", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-config-"));
  try {
    const prepared = await prepareModelConfig({ env: customEnv, root });
    assert.equal(prepared.generated, true);
    assert.equal(prepared.modelsPath, join(root, "runtime", "pi-agent", "models.json"));
    assert.deepEqual(modelConfigEnv(prepared), { PI_CODING_AGENT_DIR: join(root, "runtime", "pi-agent") });
    const text = await readFile(prepared.modelsPath, "utf8");
    assert.doesNotMatch(text, /local-secret/, "API key must not be written to models.json");

    const runtime = await ModelRuntime.create({ modelsPath: prepared.modelsPath });
    const model = runtime.getModel("ollama", "qwen2.5-coder:7b");
    assert.equal(model?.name, "Qwen Coder Local");
    assert.equal(model?.baseUrl, "http://localhost:11434/v1");
    assert.equal(runtime.getError(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit Pi models.json takes precedence over generated custom settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-file-"));
  try {
    const file = join(root, "my-pi", "models.json");
    const content = JSON.stringify({ providers: { lab: { baseUrl: "http://127.0.0.1:9000/v1", api: "openai-completions", models: [{ id: "coder" }] } } });
    await mkdir(join(root, "my-pi"), { recursive: true });
    await writeFile(file, content, "utf8");
    const prepared = await prepareModelConfig({
      env: { PI_AGENT_PROVIDER: "lab", PI_AGENT_MODEL: "coder", PI_AGENT_MODELS_FILE: file, PI_AGENT_BASE_URL: "http://ignored:1/v1" },
      root,
    });
    assert.equal(prepared.generated, false);
    assert.equal(prepared.modelsPath, file);
    assert.equal(await readFile(file, "utf8"), content);
    assert.equal(prepared.agentDir, join(root, "my-pi"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
