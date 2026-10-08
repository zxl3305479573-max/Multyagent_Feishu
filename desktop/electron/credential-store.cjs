const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { dirname } = require("node:path");

const KEY = /^(?:FEISHU_[A-Z0-9_]+_(?:APP_ID|APP_SECRET)|DEEPSEEK_API_KEY|OPENAI_API_KEY)$/;

function createCredentialStore({ file, safeStorage } = {}) {
  if (!file) throw new TypeError("credential store requires file");
  const encryption = safeStorage;
  async function read() {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { return {}; }
  }
  async function write(data) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  function validate(name) { if (!KEY.test(String(name || ""))) throw new Error("unsupported credential key"); return String(name); }
  return {
    async get(name) {
      const key = validate(name); const data = await read(); const value = data[key];
      if (!value) return "";
      if (!encryption?.isEncryptionAvailable?.()) return "";
      try { return encryption.decryptString(Buffer.from(value, "base64")); } catch { return ""; }
    },
    async set(name, value) {
      const key = validate(name); const text = String(value || "");
      if (!encryption?.isEncryptionAvailable?.()) throw new Error("OS credential encryption is unavailable");
      const data = await read();
      if (!text) delete data[key];
      else data[key] = Buffer.from(encryption.encryptString(text)).toString("base64");
      await write(data);
      return { key, configured: Boolean(text) };
    },
    async remove(name) { return this.set(name, ""); },
    async toEnv() {
      const data = await read(); const result = {};
      for (const key of Object.keys(data)) if (KEY.test(key)) result[key] = await this.get(key);
      return Object.fromEntries(Object.entries(result).filter(([, value]) => value));
    },
    async list() { const data = await read(); return Object.keys(data).filter((key) => KEY.test(key)).map((key) => key); },
  };
}

module.exports = { createCredentialStore };
