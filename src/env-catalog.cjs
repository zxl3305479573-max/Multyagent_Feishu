// 运行配置目录：网关与桌面端读取的全部环境变量。
//
// 桌面端“运行设置”页据此渲染表单：分组、类型、默认值、说明，以及哪些是密钥（加密保存）、
// 哪些由桌面端托管（只读显示）。test/env-catalog.test.js 会扫描源码里所有 process.env.X，
// 新增环境变量却没登记到这里时测试会失败，保证设置页始终覆盖全部配置。
const { roleConfig } = require("./role-config.cjs");

// pi-coding-agent 支持的模型服务商及其 API Key 环境变量。
const MODEL_PROVIDERS = [
  ["deepseek", "DeepSeek", "DEEPSEEK_API_KEY"],
  ["openai", "OpenAI", "OPENAI_API_KEY"],
  ["anthropic", "Anthropic", "ANTHROPIC_API_KEY"],
  ["google", "Google Gemini", "GEMINI_API_KEY"],
  ["azure-openai-responses", "Azure OpenAI", "AZURE_OPENAI_API_KEY"],
  ["openrouter", "OpenRouter", "OPENROUTER_API_KEY"],
  ["moonshotai", "Moonshot AI", "MOONSHOT_API_KEY"],
  ["moonshotai-cn", "Moonshot AI（中国）", "MOONSHOT_API_KEY"],
  ["kimi-coding", "Kimi For Coding", "KIMI_API_KEY"],
  ["zai", "Z.AI", "ZAI_API_KEY"],
  ["zai-coding-cn", "Z.AI Coding（中国）", "ZAI_CODING_CN_API_KEY"],
  ["qwen-token-plan", "Qwen Token Plan", "QWEN_TOKEN_PLAN_API_KEY"],
  ["qwen-token-plan-cn", "Qwen Token Plan（中国）", "QWEN_TOKEN_PLAN_CN_API_KEY"],
  ["minimax", "MiniMax", "MINIMAX_API_KEY"],
  ["minimax-cn", "MiniMax（中国）", "MINIMAX_CN_API_KEY"],
  ["xiaomi", "Xiaomi MiMo", "XIAOMI_API_KEY"],
  ["xiaomi-token-plan-cn", "Xiaomi Token Plan（中国）", "XIAOMI_TOKEN_PLAN_CN_API_KEY"],
  ["xiaomi-token-plan-sgp", "Xiaomi Token Plan（新加坡）", "XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  ["xiaomi-token-plan-ams", "Xiaomi Token Plan（阿姆斯特丹）", "XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
  ["mistral", "Mistral", "MISTRAL_API_KEY"],
  ["groq", "Groq", "GROQ_API_KEY"],
  ["xai", "xAI", "XAI_API_KEY"],
  ["cerebras", "Cerebras", "CEREBRAS_API_KEY"],
  ["fireworks", "Fireworks", "FIREWORKS_API_KEY"],
  ["together", "Together", "TOGETHER_API_KEY"],
  ["nvidia", "NVIDIA", "NVIDIA_API_KEY"],
  ["baseten", "Baseten", "BASETEN_API_KEY"],
  ["huggingface", "Hugging Face", "HF_TOKEN"],
  ["vercel-ai-gateway", "Vercel AI Gateway", "AI_GATEWAY_API_KEY"],
  ["opencode-go", "OpenCode", "OPENCODE_API_KEY"],
  ["github-copilot", "GitHub Copilot", "COPILOT_GITHUB_TOKEN"],
];

const THINKING_OPTIONS = [["off", "关闭"], ["minimal", "极少"], ["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "极高"]];

function roleFields(roles) {
  const fields = [];
  for (const role of roles) {
    fields.push({ key: role.feishu.appIdEnv, label: `${role.displayName} App ID`, type: "secret", role: role.key, description: `飞书开放平台「${role.displayName}」自建应用的 App ID。` });
    fields.push({ key: role.feishu.appSecretEnv, label: `${role.displayName} App Secret`, type: "secret", role: role.key, description: `「${role.displayName}」应用的 App Secret。缺少 App ID 或 Secret 的角色启动时会被跳过。` });
  }
  return fields;
}

function providerKeyFields() {
  const seen = new Map();
  for (const [id, name, key] of MODEL_PROVIDERS) {
    if (!seen.has(key)) seen.set(key, { key, label: `${name} API Key`, type: "secret", providers: [], description: `模型服务商 ${name} 的 API Key。` });
    seen.get(key).providers.push(id);
  }
  return [...seen.values()];
}

function buildEnvCatalog({ roles = roleConfig().roles } = {}) {
  const roleOptions = roles.map((role) => [role.key, role.displayName]);
  return [
    {
      id: "feishu",
      title: "飞书机器人",
      description: "每个角色对应一个飞书自建应用。凭据使用系统加密保存在本机。",
      fields: [
        ...roleFields(roles),
        { key: "FEISHU_ALLOWED_CHAT_ID", label: "限定群聊 ID", type: "text", placeholder: "oc_xxx，留空表示不限制", description: "只处理来自这个群聊的消息，避免机器人被拉进其他群后误触发。" },
      ],
    },
    {
      id: "model",
      title: "模型",
      description: "所有角色共用的模型服务商、模型与思考强度。",
      fields: [
        { key: "PI_AGENT_PROVIDER", label: "模型服务商", type: "select", default: "deepseek", options: MODEL_PROVIDERS.map(([id, name]) => [id, name]), allowCustom: true, description: "pi-coding-agent 中的服务商 ID。下方会显示该服务商需要的 API Key。" },
        { key: "PI_AGENT_MODEL", label: "模型", type: "text", default: "deepseek-flash", description: "服务商下的模型 ID，例如 deepseek-flash、gpt-5.1。" },
        { key: "PI_AGENT_THINKING", label: "思考强度", type: "select", default: "off", options: THINKING_OPTIONS, description: "全局默认值；角色配置里的 thinking 优先。" },
        ...providerKeyFields(),
        { key: "AZURE_OPENAI_BASE_URL", label: "Azure OpenAI Base URL", type: "text", advanced: true, provider: "azure-openai-responses", placeholder: "https://{resource}.openai.azure.com", description: "使用 Azure OpenAI 时填写（或填写资源名）。" },
        { key: "AZURE_OPENAI_RESOURCE_NAME", label: "Azure OpenAI 资源名", type: "text", advanced: true, provider: "azure-openai-responses", description: "Base URL 的替代写法。" },
        { key: "AZURE_OPENAI_API_VERSION", label: "Azure OpenAI API 版本", type: "text", advanced: true, provider: "azure-openai-responses", placeholder: "v1" },
        { key: "AZURE_OPENAI_DEPLOYMENT_NAME_MAP", label: "Azure 部署名映射", type: "text", advanced: true, provider: "azure-openai-responses", placeholder: "model=deployment,model2=deployment2" },
      ],
    },
    {
      id: "agent",
      title: "Agent 运行",
      description: "Agent 的运行方式、协作流程与超时。",
      fields: [
        { key: "PI_AGENT_RUNTIME", label: "运行模式", type: "select", default: "embedded", options: [["embedded", "进程内"], ["rpc", "RPC 子进程"]], description: "RPC 模式每个 Agent 在独立子进程中运行，超时会被终止。" },
        { key: "PI_RPC_COMMAND", label: "RPC 命令", type: "text", default: "pi", description: "仅 RPC 模式使用，需要输出 Pi RPC JSONL。" },
        { key: "PI_AGENT_WORKTREE", label: "Git worktree 隔离", type: "boolean", trueValue: "1", falseValue: "", default: "", description: "仅 RPC 模式：每个 Agent 在独立 worktree 中工作，改动收集为补丁，人工确认后再合并。" },
        { key: "PI_CONFIRM_ROLES", label: "需要人工确认的角色", type: "roles", options: roleOptions, default: "project_manager,architect,frontend_developer,backend_developer,tester,auditor", description: "这些角色交付后需要在飞书卡片上确认。只保留项目经理即仅在汇总点确认。" },
        { key: "PI_DIAGRAM_ROLES", label: "交付卡片附带架构图的角色", type: "roles", options: roleOptions, default: "architect" },
        { key: "PI_DIAGRAM_SKILL_PATH", label: "diagram-design 技能目录", type: "path", placeholder: "默认 ~/.codex/skills/diagram-design", description: "架构师和项目经理画图时使用的技能目录。" },
        { key: "PI_ARCHITECT_DIAGRAM_SKILL_PATH", label: "diagram-design 技能目录（旧名）", type: "path", advanced: true, description: "旧版本使用的变量名，优先级低于上一项。" },
        { key: "PI_MAX_DISPATCH_ROUNDS", label: "单任务最大派发轮次", type: "number", default: "8", min: 1, description: "防止角色之间无限来回派发。" },
        { key: "PI_MAX_FAILURE_RECOVERIES", label: "失败后交回项目经理的最大次数", type: "number", default: "2", min: 0, description: "执行角色失败时，最多让项目经理重新决策几次，超过后任务才判为失败。" },
        { key: "PI_CONVERSATION_TTL_MS", label: "群聊追问续接时长（毫秒）", type: "number", default: "1800000", min: 1000, description: "在这段时间内的追问会接到同一个任务上。" },
        { key: "PI_APPROVAL_TTL_MS", label: "待确认项保留时长（毫秒）", type: "number", default: "86400000", min: 1000, description: "超过时长的确认卡片在重启后不再恢复。" },
      ],
    },
    {
      id: "tickets",
      title: "GitHub 工单",
      description: "从 GitHub Issues 拉取工单交给项目经理，完成后自动回写结果。工单源在桌面端「工单」页配置。",
      fields: [
        { key: "GITHUB_TOKEN", label: "GitHub Token", type: "secret", description: "需要 Issues 读写权限（fine-grained token：Issues → Read and write）。只发送给 api.github.com 与 GitHub 附件域名。" },
      ],
    },
    {
      id: "bitable",
      title: "多维表格看板",
      description: "任务看板与执行 Trace 投影到飞书多维表格；只有项目经理应用需要表格权限。",
      fields: [
        { key: "FEISHU_BITABLE_WIKI_TOKEN", label: "知识库 Token", type: "text", placeholder: "/wiki/<token>?table=… 中的 token", description: "与 App Token 二选一。" },
        { key: "FEISHU_BITABLE_APP_TOKEN", label: "多维表格 App Token", type: "text", placeholder: "/base/<token> 中的 token" },
        { key: "FEISHU_BITABLE_TABLE_ID", label: "任务表 ID", type: "text", placeholder: "tblxxxx" },
        { key: "FEISHU_BITABLE_TRACE_TABLE_ID", label: "Trace 表 ID", type: "text", placeholder: "留空则不同步 Trace" },
        { key: "FEISHU_BITABLE_TRACE_TABLE_NAME", label: "Trace 表名称", type: "text", default: "执行 Trace", advanced: true, description: "仅 scripts/create-bitable-trace.mjs 建表时使用。" },
        { key: "FEISHU_BITABLE_AUTO_INIT", label: "自动补齐缺失字段", type: "boolean", trueValue: "true", falseValue: "false", default: "true", description: "只新增字段，不改名、不改类型、不删除。" },
        { key: "FEISHU_BITABLE_CONTROL_POLL_MS", label: "控制指令轮询间隔（毫秒）", type: "number", default: "5000", min: 1000 },
        { key: "FEISHU_BITABLE_NETWORK_BACKOFF_MS", label: "网络故障重试退避（毫秒）", type: "number", default: "30000", min: 1000 },
        { key: "FEISHU_BITABLE_RECORDS_FILE", label: "任务行映射文件", type: "path", default: "runtime/bitable-records.json", advanced: true },
        { key: "FEISHU_BITABLE_TRACE_RECORDS_FILE", label: "Trace 行映射文件", type: "path", default: "runtime/bitable-trace-records.json", advanced: true },
      ],
    },
    {
      id: "runtime",
      title: "运行与存储",
      description: "日志归档、退出与本地数据文件位置。路径留空时桌面端使用应用数据目录。",
      fields: [
        { key: "PI_EVENTS_ROTATE_MB", label: "事件日志归档阈值（MB）", type: "number", default: "50", min: 1, description: "启动时超过该大小的 events.jsonl 会被归档。" },
        { key: "PI_SHUTDOWN_TIMEOUT_MS", label: "优雅退出超时（毫秒）", type: "number", default: "10000", min: 1000 },
        { key: "PI_DESKTOP_PORT", label: "本机控制端口", type: "number", default: "0", min: 0, advanced: true, description: "0 表示随机端口。只监听 127.0.0.1。" },
        { key: "PI_DOMAIN_TASKS_FILE", label: "任务状态文件", type: "path", managedDefault: true, advanced: true },
        { key: "PI_EVENTS_FILE", label: "事件日志文件", type: "path", managedDefault: true, advanced: true },
        { key: "PI_APPROVALS_FILE", label: "待确认项文件", type: "path", managedDefault: true, advanced: true },
        { key: "PI_CHECKPOINTS_FILE", label: "暂停检查点文件", type: "path", managedDefault: true, advanced: true },
        { key: "PI_PROJECTS_FILE", label: "项目登记文件", type: "path", default: "runtime/projects.json", advanced: true },
        { key: "PI_LEGACY_TASKS_FILE", label: "旧版任务文件（迁移用）", type: "path", managedDefault: true, advanced: true },
        { key: "PI_TASKS_FILE", label: "任务状态文件（旧名）", type: "path", advanced: true, description: "旧版本变量名，优先级低于“任务状态文件”。" },
        { key: "PI_LOCK_FILE", label: "单实例锁文件", type: "path", managedDefault: true, advanced: true },
        { key: "PI_LOCK_DIR", label: "机器人全局锁目录", type: "path", advanced: true, description: "按飞书机器人 App ID 放置全局单实例锁，默认在用户目录 .multyagent-feishu/locks。命令行与桌面端须一致。" },
        { key: "PI_DATA_DIR", label: "数据根目录", type: "path", managed: true, advanced: true, description: "由桌面端管理。命令行 npm start 在 .env 中设置为同一目录即可共用任务、事件与项目。" },
        { key: "MULTYAGENT_LEGACY_ENV_FILE", label: "旧版 .env 位置（凭据迁移）", type: "path", advanced: true, description: "首次启动时从该文件导入尚未保存的凭据。" },
        { key: "PI_DESKTOP_TOKEN_FILE", label: "桌面会话令牌文件", type: "path", managed: true, advanced: true, description: "由桌面端管理，不能修改。" },
        { key: "PI_DESKTOP_CONTROL", label: "桌面控制面", type: "text", managed: true, advanced: true, description: "桌面端依赖它连接网关，始终开启。" },
        { key: "PI_DESKTOP_TOKEN", label: "桌面会话令牌", type: "text", managed: true, advanced: true, description: "每次启动随机生成，不显示也不能修改。" },
      ],
    },
  ];
}

function catalogFields(catalog = buildEnvCatalog()) {
  return catalog.flatMap((group) => group.fields.map((field) => ({ ...field, group: group.id })));
}

function isSecretKey(key, catalog) {
  return catalogFields(catalog).some((field) => field.key === key && field.type === "secret");
}

module.exports = { MODEL_PROVIDERS, buildEnvCatalog, catalogFields, isSecretKey };
