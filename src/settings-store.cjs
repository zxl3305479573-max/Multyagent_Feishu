// 运行设置：保存非密钥的环境配置（模型、Agent 运行、看板、存储路径等），并计算每项的生效值。
//
// - 非密钥值写入 <userData>/settings.json（原子写盘）；密钥仍由 credential-store 加密保存。
// - 生效值优先级：运行设置 > 桌面端托管默认值（应用数据目录下的路径）> 系统环境变量 > 内置默认值。
// - 校验规则来自 env-catalog：数字、下拉选项、开关、角色列表都在保存时检查，不合法直接拒绝。
const { readJsonFile, writeFileAtomic } = require("./atomic-file.cjs");
const { buildEnvCatalog, catalogFields } = require("./env-catalog.cjs");

const MAX_LENGTH = 4000;

function normalizeValue(field, raw, { roleKeys = [] } = {}) {
  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  if (/[\r\n\0]/.test(text)) throw new Error(`${field.label}：不能包含换行`);
  if (text.length > MAX_LENGTH) throw new Error(`${field.label}：内容过长`);
  if (text === "") return "";
  switch (field.type) {
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`${field.label}：必须是整数`);
      if (field.min !== undefined && value < field.min) throw new Error(`${field.label}：不能小于 ${field.min}`);
      return String(value);
    }
    case "select": {
      const allowed = (field.options || []).map(([value]) => value);
      if (!allowed.includes(text) && !field.allowCustom) throw new Error(`${field.label}：只能是 ${allowed.join(" / ")}`);
      if (field.allowCustom && !/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`${field.label}：只能包含字母、数字、点、下划线和连字符`);
      return text;
    }
    case "boolean": {
      const truthy = ["1", "true", "yes", "on", String(field.trueValue)].includes(text.toLowerCase());
      const falsy = ["0", "false", "no", "off", String(field.falseValue)].includes(text.toLowerCase());
      if (!truthy && !falsy) throw new Error(`${field.label}：只能是开或关`);
      return truthy ? String(field.trueValue) : String(field.falseValue);
    }
    case "roles": {
      const items = [...new Set(text.split(",").map((item) => item.trim()).filter(Boolean))];
      const unknown = roleKeys.length ? items.filter((item) => !roleKeys.includes(item)) : [];
      if (unknown.length) throw new Error(`${field.label}：未知角色 ${unknown.join("、")}`);
      return items.join(",");
    }
    default:
      return text;
  }
}

function createSettingsStore({ file, catalog = buildEnvCatalog(), roleKeys = [], log = console } = {}) {
  if (!file) throw new TypeError("settings store requires file");
  const fields = new Map(catalogFields(catalog).map((field) => [field.key, field]));
  let writing = Promise.resolve();

  async function read() {
    const data = await readJsonFile(file, { fallback: () => ({ version: 1, values: {} }), onCorrupt: "backup", log });
    const values = data && typeof data.values === "object" && data.values ? data.values : {};
    // 只保留目录里登记过的非密钥项，忽略旧版本留下的未知键。
    return Object.fromEntries(Object.entries(values).filter(([key, value]) => {
      const field = fields.get(key);
      return field && field.type !== "secret" && !field.managed && typeof value === "string" && value !== "";
    }));
  }

  async function write(values) {
    writing = writing.then(() => writeFileAtomic(file, `${JSON.stringify({ version: 1, values }, null, 2)}\n`));
    await writing;
  }

  function fieldFor(key) {
    const field = fields.get(String(key || ""));
    if (!field) throw new Error(`未知配置项：${key}`);
    if (field.type === "secret") throw new Error(`${field.label} 是密钥，请通过凭据接口保存`);
    if (field.managed) throw new Error(`${field.label} 由桌面端管理，不能修改`);
    return field;
  }

  return {
    catalog,
    read,
    async set(key, value) {
      const field = fieldFor(key);
      const normalized = normalizeValue(field, value, { roleKeys });
      const values = await read();
      if (normalized === "") delete values[field.key];
      else values[field.key] = normalized;
      await write(values);
      return { key: field.key, value: normalized };
    },
    // 一次保存多项：先全部校验，任何一项不合法都不落盘。
    async setMany(entries = {}) {
      const values = await read();
      const errors = [];
      for (const [key, value] of Object.entries(entries)) {
        try {
          const field = fieldFor(key);
          const normalized = normalizeValue(field, value, { roleKeys });
          if (normalized === "") delete values[field.key];
          else values[field.key] = normalized;
        } catch (error) {
          errors.push(error.message);
        }
      }
      if (errors.length) throw new Error(errors.join("；"));
      await write(values);
      return values;
    },
    async reset(key) { return this.set(key, ""); },
    // 交给网关子进程的环境变量（只含用户设置过的项）。
    async toEnv() { return read(); },
  };
}

// 计算设置页需要的快照：每项的生效值与来源。密钥只报告是否已配置，不返回明文。
function describeSettings({ catalog, values = {}, managed = {}, systemEnv = {}, secrets = { encryptionAvailable: true, keys: [] } }) {
  const secretState = new Map((secrets.keys || []).map((item) => [item.key, item]));
  const entries = {};
  for (const field of catalogFields(catalog)) {
    if (field.type === "secret") {
      const saved = secretState.get(field.key);
      entries[field.key] = {
        configured: Boolean(saved),
        readable: Boolean(saved?.readable),
        source: saved ? "设置" : systemEnv[field.key] ? "系统环境变量" : "未配置",
        fromSystemEnv: !saved && Boolean(systemEnv[field.key]),
      };
      continue;
    }
    let value = "";
    let source = "默认";
    if (field.key === "PI_DESKTOP_TOKEN") {
      value = "（每次启动随机生成）";
      source = "桌面端管理";
    } else if (values[field.key] !== undefined && !field.managed) {
      value = values[field.key];
      source = "设置";
    } else if (managed[field.key] !== undefined) {
      value = managed[field.key];
      source = "桌面端管理";
    } else if (systemEnv[field.key]) {
      value = systemEnv[field.key];
      source = "系统环境变量";
    } else {
      value = field.default ?? "";
    }
    entries[field.key] = { value: values[field.key] ?? "", effective: value, source };
  }
  return { groups: catalog, entries, encryptionAvailable: secrets.encryptionAvailable !== false };
}

module.exports = { createSettingsStore, describeSettings, normalizeValue };
