// 网关进程内唯一的能力库实例：Agent 运行时按角色读取，桌面端命令负责增删改。
import { roleConfig } from "../role-config.cjs";
import { createCapabilityRegistry } from "./registry.js";

let registry = null;

export function getCapabilityRegistry() {
  if (!registry) {
    const config = roleConfig();
    const roleKeys = config.agents.map((agent) => agent.key);
    const baseTools = Object.fromEntries(roleKeys.map((key) => {
      const configured = config.policy.agents?.[key]?.tools || [];
      return [key, [...new Set([
        ...configured,
        "deliver_artifact",
        "agent_cli",
        "get_task_status",
        ...(key === "project_manager" ? ["create_project"] : []),
      ])]];
    }));
    registry = createCapabilityRegistry({ roleKeys, baseTools });
  }
  return registry;
}

/** 测试或嵌入场景替换默认实例。 */
export function setCapabilityRegistry(value) {
  registry = value;
}
