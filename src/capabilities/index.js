// 网关进程内唯一的能力库实例：Agent 运行时按角色读取，桌面端命令负责增删改。
import { roleConfig } from "../role-config.cjs";
import { createCapabilityRegistry } from "./registry.js";

let registry = null;

export function getCapabilityRegistry() {
  if (!registry) registry = createCapabilityRegistry({ roleKeys: roleConfig().agents.map((agent) => agent.key) });
  return registry;
}

/** 测试或嵌入场景替换默认实例。 */
export function setCapabilityRegistry(value) {
  registry = value;
}
