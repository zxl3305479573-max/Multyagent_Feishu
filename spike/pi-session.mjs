// Spike 1: 验证 "Pi 会话能被驱动" —— 创建 AgentSession、prompt、拿到回复、观察 agent_settled。
// 运行: node spike/pi-session.mjs
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

const MODEL_PROVIDER = "deepseek";
const MODEL_ID = process.env.PI_MODEL || "deepseek-v4-pro";

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(MODEL_PROVIDER, MODEL_ID);
if (!model) {
  console.error(`[FAIL] 模型未找到: ${MODEL_PROVIDER}/${MODEL_ID}`);
  const available = await modelRuntime.getAvailable();
  console.error(`可用模型: ${available.map((m) => `${m.provider}/${m.id}`).join(", ") || "(无)"}`);
  process.exit(1);
}
console.log(`[model] ${model.provider}/${model.id} (thinking=${model.reasoning})`);

const { session } = await createAgentSession({
  model,
  thinkingLevel: "off",
  modelRuntime,
  tools: ["read", "ls"],
  sessionManager: SessionManager.inMemory(),
});

let reply = "";
let settled = false;

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
    case "agent_end":
      console.log(`\n[agent_end] willRetry=${event.willRetry}`);
      break;
    case "agent_settled":
      settled = true;
      console.log("\n[settled] agent_settled fired");
      break;
  }
});

try {
  await session.prompt("列出当前目录的文件，然后用一句话总结你看到了什么。");
  console.log("\n--- 结果 ---");
  console.log(reply || "(无文本回复)");
  console.log(`agent_settled 触发: ${settled ? "是" : "否"}`);
  if (!settled || !reply) {
    console.error("[FAIL] 链路未完整跑通");
    process.exitCode = 1;
  }
} finally {
  session.dispose();
}
