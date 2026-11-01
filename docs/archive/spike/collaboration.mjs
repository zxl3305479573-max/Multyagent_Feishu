// 协作链路验证：项目经理产出计划 → 编排层派发架构师 → 架构师交付。
// 运行: node spike/collaboration.mjs
import { runAgent } from "../src/pi-agent.js";
import { createOrchestrator } from "../src/orchestrator.js";

function mockClient(name) {
  return {
    im: {
      message: {
        create: async (args) => {
          const content = JSON.parse(args.data.content);
          console.log(`\n[${name} 回帖]\n${content.text}`);
          return { code: 0 };
        },
      },
    },
  };
}

const pm = { key: "project_manager", displayName: "项目经理", appId: "cli_pm" };
const architect = { key: "architect", displayName: "架构设计师", appId: "cli_arch" };
const frontend = { key: "frontend_developer", displayName: "前端开发", appId: "cli_fe" };
const backend = { key: "backend_developer", displayName: "后端开发", appId: "cli_be" };
const tester = { key: "tester", displayName: "测试", appId: "cli_te" };
const auditor = { key: "auditor", displayName: "审计", appId: "cli_au" };

const orchestrator = createOrchestrator({ runAgent, maxRounds: 6 });
orchestrator.registerRole(pm, mockClient("项目经理"));
orchestrator.registerRole(architect, mockClient("架构师"));
orchestrator.registerRole(frontend, mockClient("前端开发"));
orchestrator.registerRole(backend, mockClient("后端开发"));
orchestrator.registerRole(tester, mockClient("测试"));
orchestrator.registerRole(auditor, mockClient("审计"));

const taskId = "TEST-COLLAB-1";
const context = { taskId, agentKey: "project_manager", appId: "cli_pm", chatId: "c1", projectName: "collab-demo" };

console.log("=== 第一步：项目经理产出计划 ===");
const result = await runAgent(
  pm,
  "做一个手机号登录功能。请产出需求计划，写入 plan.md，并调用 deliver_artifact 交付（summary、artifactPaths=['plan.md']、next 都填）。",
  context,
);
console.log("\n[项目经理回复]", result.text);
console.log("[delivery]", JSON.stringify(result.delivery, null, 2));

if (result.delivery) {
  console.log("\n=== 第二步：编排层按路由表派发（架构师 → 前端+后端并行）===");
  await orchestrator.onTaskCompleted("project_manager", taskId, { delivery: result.delivery, context });
} else {
  console.log("\n[FAIL] 项目经理未调用 deliver_artifact，无法触发派发");
  process.exitCode = 1;
}
