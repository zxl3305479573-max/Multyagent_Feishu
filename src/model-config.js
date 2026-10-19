import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-file.cjs";

export const MODEL_API_TYPES = [
  ["openai-completions", "OpenAI Chat Completions（兼容服务）"],
  ["openai-responses", "OpenAI Responses"],
  ["anthropic-messages", "Anthropic Messages"],
  ["google-generative-ai", "Google Generative AI"],
];

export const THINKING_LEVELS = [
  ["off", "关闭"],
  ["minimal", "极少"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "极高"],
];

const API_TYPES = new Set(MODEL_API_TYPES.map(([value]) => value));
const THINKING_VALUES = new Set(THINKING_LEVELS.map(([value]) => value));
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function text(value) {
  return String(value ?? "").trim();
}

function boolean(value) {
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

function positiveInteger(value, label, errors) {
  const raw = text(value);
  if (!raw) return undefined;
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    errors.push(`${label}必须是正整数`);
    return undefined;
  }
  return number;
}

function absolutePath(path, root) {
  const value = text(path);
  const expanded = value === "~" ? homedir() : value.startsWith("~/") || value.startsWith("~\\")
    ? join(homedir(), value.slice(2))
    : value;
  return isAbsolute(expanded) ? expanded : resolve(root, expanded);
}

export function selectedModel(env = process.env) {
  return {
    provider: text(env.PI_AGENT_PROVIDER) || "deepseek",
    model: text(env.PI_AGENT_MODEL) || "deepseek-flash",
  };
}

export function configuredThinking(env = process.env) {
  const value = text(env.PI_AGENT_THINKING);
  return THINKING_VALUES.has(value) ? value : null;
}

export function currentRuntimeSettings(env = process.env) {
  return { ...selectedModel(env), thinking: configuredThinking(env) || "off" };
}

function modelChoices(runtime, provider) {
  return runtime.getModels(provider)
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      reasoning: model.reasoning === true,
      contextWindow: model.contextWindow || null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** Compact runtime selector payload; only the selected provider's model list is returned. */
export function runtimeConfigPayload(runtime, { env = process.env, provider } = {}) {
  const current = currentRuntimeSettings(env);
  const listingProvider = text(provider) || current.provider;
  const providers = runtime.getProviders().map((item) => ({
    id: item.id,
    name: item.name || item.id,
    modelCount: runtime.getModels(item.id).length,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const models = modelChoices(runtime, listingProvider);
  const currentModel = runtime.getModel(current.provider, current.model);
  if (listingProvider === current.provider && currentModel && !models.some((item) => item.id === current.model)) {
    models.unshift({
      id: current.model,
      name: currentModel.name || current.model,
      reasoning: currentModel.reasoning === true,
      contextWindow: currentModel.contextWindow || null,
    });
  }
  return {
    ...current,
    listingProvider,
    providers,
    models,
    thinkingLevels: THINKING_LEVELS.map(([value, label]) => ({ value, label })),
  };
}

/** Apply a switch to the gateway process; the caller persists the same values for restarts. */
export function applyRuntimeConfig(runtime, input = {}, { env = process.env } = {}) {
  const provider = text(input.provider);
  const model = text(input.model);
  const thinking = text(input.thinking) || configuredThinking(env) || "off";
  if (!provider || !model) throw new Error("模型服务商和模型 ID 不能为空");
  if (!THINKING_VALUES.has(thinking)) throw new Error(`不支持的思考强度：${thinking}`);
  if (!runtime.getModel(provider, model)) throw new Error(`模型不存在或当前 Pi 配置未加载：${provider}/${model}`);
  env.PI_AGENT_PROVIDER = provider;
  env.PI_AGENT_MODEL = model;
  env.PI_AGENT_THINKING = thinking;
  return runtimeConfigPayload(runtime, { env, provider });
}

/** Build the provider/model block consumed by Pi's models.json. */
export function buildCustomModelsConfig(env = process.env) {
  const { provider, model } = selectedModel(env);
  const baseUrl = text(env.PI_AGENT_BASE_URL);
  if (!baseUrl) return null;

  const errors = [];
  if (!PROVIDER_ID.test(provider)) errors.push("服务商 ID 只能包含字母、数字、点、下划线和连字符");
  let parsedUrl;
  try { parsedUrl = new URL(baseUrl); } catch { errors.push("Base URL 不是合法地址"); }
  if (parsedUrl && !["http:", "https:"].includes(parsedUrl.protocol)) errors.push("Base URL 只支持 http/https");
  const api = text(env.PI_AGENT_API_TYPE) || "openai-completions";
  if (!API_TYPES.has(api)) errors.push(`不支持的 API 类型：${api}`);
  if (!model) errors.push("模型 ID 不能为空");
  const contextWindow = positiveInteger(env.PI_AGENT_CONTEXT_WINDOW, "上下文窗口", errors);
  const maxTokens = positiveInteger(env.PI_AGENT_MAX_TOKENS, "最大输出 Token", errors);
  if (errors.length) throw new Error(`自定义模型配置无效：${errors.join("；")}`);

  const compat = api === "openai-completions" ? {
    supportsDeveloperRole: boolean(env.PI_AGENT_SUPPORTS_DEVELOPER_ROLE),
    supportsReasoningEffort: boolean(env.PI_AGENT_SUPPORTS_REASONING_EFFORT),
  } : undefined;
  return {
    providers: {
      [provider]: {
        baseUrl,
        api,
        // Keep the secret out of the generated file. Pi resolves this at request time.
        ...(text(env.PI_AGENT_API_KEY) ? { apiKey: "$PI_AGENT_API_KEY" } : {}),
        ...(compat ? { compat } : {}),
        models: [{
          id: model,
          ...(text(env.PI_AGENT_MODEL_NAME) ? { name: text(env.PI_AGENT_MODEL_NAME) } : {}),
          input: ["text"],
          reasoning: boolean(env.PI_AGENT_MODEL_REASONING),
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxTokens ? { maxTokens } : {}),
        }],
      },
    },
  };
}

/**
 * Resolve the Pi model catalog used by embedded and RPC agents.
 * - PI_AGENT_MODELS_FILE takes precedence and supports fully custom models.json files.
 * - PI_AGENT_BASE_URL creates a managed models.json from the desktop form.
 * - With neither, Pi keeps its normal ~/.pi/agent/models.json behavior.
 */
export async function prepareModelConfig({ env = process.env, root = process.cwd(), write = writeFileAtomic } = {}) {
  const explicit = text(env.PI_AGENT_MODELS_FILE);
  if (explicit) {
    const modelsPath = absolutePath(explicit, root);
    if (!existsSync(modelsPath)) throw new Error(`Pi 模型配置文件不存在：${modelsPath}`);
    // Pi accepts BOM, comments and its full provider schema; let its own ModelConfig
    // parser validate the file so this layer does not reject valid configurations.
    return { modelsPath, agentDir: dirname(modelsPath), generated: false, ...selectedModel(env) };
  }

  const config = buildCustomModelsConfig(env);
  if (!config) return null;
  const agentDir = join(root, "runtime", "pi-agent");
  const modelsPath = join(agentDir, "models.json");
  await write(modelsPath, `${JSON.stringify(config, null, 2)}\n`);
  return { modelsPath, agentDir, generated: true, ...selectedModel(env) };
}

/** RPC Pi reads models.json from PI_CODING_AGENT_DIR, so point it at the resolved catalog. */
export function modelConfigEnv(config) {
  return config?.agentDir ? { PI_CODING_AGENT_DIR: config.agentDir } : {};
}
