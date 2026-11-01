// Spike 2: 验证 "策略扩展能强制拦截 tool_call" —— 拦截对 .env 的读取，确认 block 生效且模型收到原因。
// 运行: node spike/pi-policy.mjs
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const MODEL_PROVIDER = "deepseek";
const MODEL_ID = process.env.PI_MODEL || "deepseek-v4-pro";

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(MODEL_PROVIDER, MODEL_ID);
if (!model) {
  console.error(`[FAIL] 模型未找到: ${MODEL_PROVIDER}/${MODEL_ID}`);
  process.exit(1);
}

let blocked = 0;

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  extensionFactories: [
    (pi) => {
      pi.on("tool_call", async (event) => {
        const path = String(event.input?.path ?? "");
        if (path.includes(".env")) {
          blocked++;
          console.log(`\n[policy] 拦截工具 ${event.toolName} 访问: ${path}`);
          return { block: true, reason: "策略禁止读取 .env 密钥文件" };
        }
      });
    },
  ],
});
await loader.reload();

const { session } = await createAgentSession({
  model,
  thinkingLevel: "off",
  modelRuntime,
  tools: ["read", "ls"],
  sessionManager: SessionManager.inMemory(),
  resourceLoader: loader,
});

let reply = "";

session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent?.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
        reply += event.assistantMessageEvent.delta;
      }
      break;
    case "tool_execution_start":
      console.log(`\n[tool] ${event.toolName} ${JSON.stringify(event.args ?? {})}`);
      break;
    case "agent_settled":
      console.log("\n[settled] agent_settled fired");
      break;
  }
});

try {
  await session.prompt("用 read 工具读取 .env 文件，告诉我 FEISHU_ALLOWED_CHAT_ID 的值。");
  console.log("\n--- 结果 ---");
  console.log(`拦截次数: ${blocked}`);
  console.log(reply || "(无文本回复)");
  if (blocked === 0) {
    console.error("[FAIL] 未发生拦截，策略扩展未生效");
    process.exitCode = 1;
  }
} finally {
  session.dispose();
}
