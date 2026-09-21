import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Client, EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { runAgent } from "./handlers.js";
import { createCardActionHandler, createRoleHandler } from "./gateway.js";
import { createOrchestrator } from "./orchestrator.js";
import { TaskStore } from "./domain/task-store.js";
import { createEventLogger } from "./observability.js";

const config = JSON.parse(await readFile(new URL("../config/agents.json", import.meta.url), "utf8"));
const allowedChatId = process.env.FEISHU_ALLOWED_CHAT_ID || "";
const active = [];
const eventLogger = createEventLogger(process.env.PI_EVENTS_FILE || "runtime/events.jsonl");
const orchestrator = createOrchestrator({ runAgent, onEvent: eventLogger });
const taskStore = new TaskStore(process.env.PI_DOMAIN_TASKS_FILE || "runtime/domain-tasks.json");
await taskStore.recoverRunning();

for (const definition of config.agents) {
  const appId = process.env[definition.appIdEnv];
  const appSecret = process.env[definition.appSecretEnv];
  if (!definition.enabled || !appId || !appSecret) {
    console.log(`[skip] ${definition.key}: missing credentials`);
    continue;
  }

  const agent = { ...definition, appId };
  const client = new Client({ appId, appSecret });
  orchestrator.registerRole(agent, client);
  const handler = createRoleHandler({
    agent,
    client,
    runAgent,
    orchestrator,
    taskStore,
    isAllowedChat: (chatId) => !allowedChatId || chatId === allowedChatId,
  });
  const cardActionHandler = createCardActionHandler({ orchestrator, client, agent });
  const wsClient = new WSClient({
    appId,
    appSecret,
    loggerLevel: LoggerLevel.info,
    onError: (error) => console.error(`[error] ${definition.key} (${definition.displayName}) connection failed: ${error.message}`),
  });
  wsClient.start({
    eventDispatcher: new EventDispatcher({}).register({
      "im.message.receive_v1": handler,
      "card.action.trigger": cardActionHandler,
    }),
  });
  active.push(definition.key);
  console.log(`[start] ${definition.key} (${definition.displayName}) connected`);
}

if (!active.length) {
  console.error("No configured Feishu bots. Copy .env.example to .env and fill at least one App ID and App Secret.");
  process.exitCode = 1;
} else {
  console.log(`[ready] active agents: ${active.join(", ")}`);
}
