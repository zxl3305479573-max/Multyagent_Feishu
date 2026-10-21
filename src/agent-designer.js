// @ts-check
// AI 设计自建角色：根据用户的需求与触发条件，让模型起草身份提示词（职责/目标/规则/流程）、
// 工具白名单与权限范围。模型只产出草稿，最终由 custom-roles.cjs 归一化与校验，用户可再人工修改。
import customRoles from "./custom-roles.cjs";

const { DESIGNABLE_TOOLS, TOOL_CATALOG, normalizeRole, slugKey, uniqueKey } = customRoles;

export function buildDesignPrompt({ requirement, triggers = [], displayName = "", team = [], current = null }) {
  const lines = [
    "你是多智能体团队的角色设计师。请根据用户需求，为团队设计一个新的 Agent 角色，并只输出一个 JSON 对象（不要 Markdown 代码块、不要解释）。",
    "",
    `用户需求：${requirement}`,
    triggers.length ? `用户给出的触发条件：\n${triggers.map((item) => `- ${item}`).join("\n")}` : "用户未给出触发条件，请根据需求推断 2-4 条。",
    displayName ? `期望的显示名：${displayName}` : "",
    team.length ? `团队已有角色（不要与其职责重叠，不要使用这些 key）：\n${team.map((item) => `- ${item.key}（${item.displayName}）${item.duty ? `：${item.duty}` : ""}`).join("\n")}` : "",
    current ? `当前草稿（在此基础上改进，保留用户明显手工修改的部分）：\n${JSON.stringify(current)}` : "",
    "",
    "JSON 字段：",
    "- key：小写英文 + 下划线，2-41 个字符，例如 data_analyst",
    "- displayName：中文显示名，简短",
    "- duty：一句话职责",
    "- goal：一句话目标，说明交付什么才算完成",
    "- rules：3-6 条行为约束（字符串数组）；不要写可写目录、Shell、联网权限，这些由系统根据权限字段自动生成",
    "- workflow：一段话描述工作步骤",
    "- triggers：2-5 条触发条件（字符串数组），描述项目经理在什么情况下应该派发这个角色，要具体、可判断",
    `- tools：工具白名单，只能从以下选择，遵循最小权限：${TOOL_CATALOG.map(([tool, label]) => `${tool}（${label}）`).join("、")}`,
    "- shellMode：none（无 Shell）/ readonly（只读命令和测试）/ write（可写命令），tools 里没有 bash/powershell 时必须为 none",
    "- writePaths：有 write/edit 时的可写目录（仓库内相对路径，可用 {project} 占位符），通常为 workspace/{project}/artifacts",
    "- networkAccess：是否需要联网（布尔值），需要时在 networkDomains 列出域名",
    "- thinking：off / low / medium / high",
    "- limits：{ maxTurns, maxRuntimeSeconds }，按任务复杂度给出",
    "- rationale：一句话说明权限取舍的理由",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

// 从模型回复里取出 JSON：容忍代码块包裹和前后多余文字。
export function parseDesign(reply) {
  const raw = String(reply || "").replace(/```(?:json)?/gi, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON 设计稿");
  try { return JSON.parse(raw.slice(start, end + 1)); }
  catch (error) { throw new Error(`模型返回的设计稿不是合法 JSON：${error.message}`); }
}

/**
 * @param {{ requirement: string, triggers?: string[], displayName?: string, current?: object | null, team?: Array<{key: string, displayName: string, duty?: string}>, taken?: Set<string>, generate: (input: {system: string, prompt: string}) => Promise<string> }} input
 */
export async function designAgent({ requirement, triggers = [], displayName = "", current = null, team = [], taken = new Set(), generate }) {
  const need = String(requirement || "").trim();
  if (!need) throw new Error("请先描述这个 Agent 要解决的需求");
  if (typeof generate !== "function") throw new Error("模型不可用，无法自动设计");
  const userTriggers = (Array.isArray(triggers) ? triggers : []).map((item) => String(item).trim()).filter(Boolean);
  const reply = await generate({
    system: "你只输出 JSON。",
    prompt: buildDesignPrompt({ requirement: need, triggers: userTriggers, displayName, team, current }),
  });
  const design = parseDesign(reply);
  // AI 只能从开放给自建角色的工具里选；用户写下的触发条件优先保留，AI 补充的追加在后。
  const tools = (Array.isArray(design.tools) ? design.tools : []).filter((tool) => DESIGNABLE_TOOLS.has(tool));
  // normalizeRole 只给非法 key 去重；AI 起的 key 即使合法也可能与已有角色重名，这里先避开，免得保存时才报错。
  const key = current?.key || (design.key ? uniqueKey(slugKey(design.key), taken) : undefined);
  const role = normalizeRole({
    ...design,
    tools,
    key,
    displayName: displayName || design.displayName,
    requirement: need,
    triggers: [...userTriggers, ...(Array.isArray(design.triggers) ? design.triggers : [])],
  }, { taken });
  return { role, rationale: String(design.rationale || "").trim() };
}

// 桌面端“自定义 Agent”页面的服务：列表 / AI 设计 / 保存 / 删除。
// 角色配置在网关启动时加载，保存后需要重启服务才生效；loadedRoles 是本次启动加载的自建角色，
// 用来标注每个角色是“已生效”还是“待重启”。
export function createCustomAgentService({ store, loadedRoles = [], builtInRoles = [], generate }) {
  const loaded = new Map(loadedRoles.map((role) => [role.key, JSON.stringify({ ...role, custom: true })]));
  const team = () => [...builtInRoles, ...store.list().filter((role) => !role.errors)]
    .map((role) => ({ key: role.key, displayName: role.displayName, duty: role.duty }));
  return {
    list() {
      const agents = store.list().map((role) => ({
        ...role,
        status: role.errors ? "invalid" : loaded.get(role.key) === JSON.stringify({ ...role, custom: true }) ? "active" : "pending",
      }));
      const removed = [...loaded.keys()].filter((key) => !agents.some((role) => role.key === key));
      return {
        agents,
        tools: TOOL_CATALOG.map(([name, label]) => ({ name, label })),
        reserved: [...store.reserved],
        restartNeeded: removed.length > 0 || agents.some((role) => role.status !== "active"),
      };
    },
    /** @param {{ requirement?: string, triggers?: string[], displayName?: string, current?: any, originalKey?: string }} [input] */
    async design({ requirement = "", triggers = [], displayName = "", current = null, originalKey = "" } = {}) {
      return designAgent({ requirement, triggers, displayName, current, team: team().filter((role) => role.key !== originalKey), taken: store.takenKeys(originalKey), generate });
    },
    /** @param {{ role?: any, originalKey?: string }} [input] */
    async save({ role = {}, originalKey = "" } = {}) {
      return { role: await store.save(role, { originalKey }) };
    },
    /** @param {{ key?: string }} [input] */
    remove({ key = "" } = {}) {
      return store.remove(String(key));
    },
  };
}
