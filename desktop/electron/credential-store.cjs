const { readJsonFile, writeFileAtomic } = require("../../src/atomic-file.cjs");

// 默认允许的密钥名：飞书应用凭据与模型服务商密钥。桌面端会传入 env-catalog 里登记的密钥清单。
const DEFAULT_KEY = /^(?:FEISHU_[A-Z0-9_]+_(?:APP_ID|APP_SECRET)|[A-Z0-9_]+_API_KEY|HF_TOKEN|COPILOT_GITHUB_TOKEN)$/;

class CredentialEncryptionUnavailableError extends Error {
  constructor() {
    super("系统凭据加密不可用（Windows DPAPI / macOS Keychain / Linux Secret Service 未就绪），无法读取或保存凭据");
    this.name = "CredentialEncryptionUnavailableError";
    this.code = "ENCRYPTION_UNAVAILABLE";
  }
}

function createCredentialStore({ file, safeStorage, log = console, isAllowedKey = (key) => DEFAULT_KEY.test(key) } = {}) {
  if (!file) throw new TypeError("credential store requires file");
  const KEY = { test: (key) => isAllowedKey(String(key || "")) };
  const encryption = safeStorage;
  const encryptionAvailable = () => Boolean(encryption?.isEncryptionAvailable?.());
  async function read() {
    // 凭据文件损坏时备份后按空处理，避免下一次保存把旧凭据整体覆盖掉且无从找回。
    const data = await readJsonFile(file, { fallback: {}, onCorrupt: "backup", log });
    return data && typeof data === "object" ? data : {};
  }
  async function write(data) {
    await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  }
  function validate(name) { if (!KEY.test(String(name || ""))) throw new Error("unsupported credential key"); return String(name); }
  function decrypt(value) {
    try { return { ok: true, value: encryption.decryptString(Buffer.from(value, "base64")) }; } catch { return { ok: false, value: "" }; }
  }
  return {
    encryptionAvailable,
    async get(name) {
      const key = validate(name); const data = await read(); const value = data[key];
      if (!value) return "";
      if (!encryptionAvailable()) throw new CredentialEncryptionUnavailableError();
      return decrypt(value).value;
    },
    async set(name, value) {
      const key = validate(name); const text = String(value || "");
      const data = await read();
      if (!text) delete data[key];
      else {
        if (!encryptionAvailable()) throw new CredentialEncryptionUnavailableError();
        data[key] = Buffer.from(encryption.encryptString(text)).toString("base64");
      }
      await write(data);
      return { key, configured: Boolean(text) };
    },
    async remove(name) { return this.set(name, ""); },
    async toEnv() {
      const data = await read(); const result = {};
      if (!encryptionAvailable()) {
        if (Object.keys(data).some((key) => KEY.test(key))) log.error?.(`[credentials] ${new CredentialEncryptionUnavailableError().message}`);
        return result;
      }
      for (const [key, value] of Object.entries(data)) {
        if (!KEY.test(key) || !value) continue;
        const decrypted = decrypt(value);
        if (decrypted.ok && decrypted.value) result[key] = decrypted.value;
        else log.warn?.(`[credentials] ${key} 无法解密（可能来自另一台电脑或另一个系统账户），请在设置中重新保存`);
      }
      return result;
    },
    async list() { const data = await read(); return Object.keys(data).filter((key) => KEY.test(key)); },
    // 设置页使用：区分“未配置”“已配置”“已保存但无法解密”和“系统加密不可用”。
    async status() {
      const data = await read();
      const available = encryptionAvailable();
      const keys = Object.keys(data).filter((key) => KEY.test(key)).map((key) => ({
        key,
        readable: available && decrypt(data[key]).ok,
      }));
      return { encryptionAvailable: available, keys };
    },
  };
}

module.exports = { createCredentialStore, CredentialEncryptionUnavailableError };
