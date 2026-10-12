// @ts-check
// 角色间默认流转路由（config/routes.json）与派发轮次上限。
import { readFileSync } from "node:fs";

export const routesConfig = JSON.parse(readFileSync(new URL("../../config/routes.json", import.meta.url), "utf8"));

export const MAX_DISPATCH_ROUNDS = Number(process.env.PI_MAX_DISPATCH_ROUNDS) || 8;

// Agent 交付里 next 字段为空或只是“已完成”之类的收尾语时，不再触发后续派发。
export function isTerminalNext(value) {
  const text = String(value || "").trim();
  return !text || /^(?:无需后续操作|无(?:需|其他)?下一步|没有下一步|任务已完成|已完成(?:任务)?|完成)$/i.test(text);
}

export function matchRoutes(routes, agentKey) {
  const matched = [];
  for (const rule of routes) {
    const froms = Array.isArray(rule.from) ? rule.from : [rule.from];
    if (!froms.includes(agentKey)) continue;
    matched.push({
      froms,
      tos: Array.isArray(rule.to) ? rule.to : [rule.to],
      when: rule.when || "always",
    });
  }
  return matched;
}
