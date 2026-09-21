// 项目路由验证：项目经理确认项目名 → create_project → 产物写入 workspace/<项目名>/。
// 运行: node spike/project-route.mjs
import { runAgent } from "../src/pi-agent.js";
import { existsSync } from "node:fs";

const pm = { key: "project_manager", displayName: "项目经理", appId: "cli_pm" };

const result = await runAgent(
  pm,
  "用户需求：做一个手机号登录功能。用户已确认项目英文名为 phone-login。请创建项目并产出需求计划。",
  { taskId: "T-route-1" },
);

console.log("\n=== 项目经理回复 ===");
console.log(result.text);
console.log("\nprojectName:", result.projectName);
console.log("delivery.artifactsDir:", result.delivery?.artifactsDir);
console.log("\n=== 文件检查 ===");
console.log("项目目录存在:", existsSync("workspace/phone-login"));
console.log("项目产物目录存在:", existsSync("workspace/phone-login/artifacts/T-route-1"));
