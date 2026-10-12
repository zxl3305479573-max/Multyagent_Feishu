const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, safeStorage, shell } = require("electron");
const { join } = require("node:path");
const { mkdir, readFile } = require("node:fs/promises");
const { resolveProjectFile } = require("../../src/project-file.cjs");
const { createCredentialStore } = require("./credential-store.cjs");
const { createGatewayProcess } = require("./gateway-process.cjs");
const { buildEnvCatalog, catalogFields, isSecretKey } = require("../../src/env-catalog.cjs");
const { createSettingsStore, describeSettings } = require("../../src/settings-store.cjs");
const { roleConfig } = require("../../src/role-config.cjs");

const root = join(__dirname, "..", "..");
let win = null; let tray = null; let quitting = false; let gateway = null; let credentials = null; let settings = null; let gatewayStopping = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
// 运行设置页展示的全部环境配置（分组、类型、默认值、是否密钥）。
const envCatalog = buildEnvCatalog();
const roleKeys = roleConfig().roles.map((role) => role.key);
const LEGACY_CREDENTIAL_KEY = { test: (key) => isSecretKey(key, envCatalog) };
// 首次启动时从旧版 .env 迁移凭据：默认读取应用目录下的 .env，
// 其他位置通过运行设置或环境变量 MULTYAGENT_LEGACY_ENV_FILE 指定（不要写死开发机路径）。
function legacyEnvFiles(configured) {
  return [configured, process.env.MULTYAGENT_LEGACY_ENV_FILE, join(root, ".env")].filter(Boolean);
}

function parseLegacyEnv(text) {
  const result = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || !LEGACY_CREDENTIAL_KEY.test(match[1])) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) result[match[1]] = value;
  }
  return result;
}

async function migrateLegacyCredentials(configuredFile) {
  if (!credentials.encryptionAvailable()) return;
  let source = "";
  let text = "";
  for (const candidate of legacyEnvFiles(configuredFile)) {
    try {
      text = await readFile(candidate, "utf8");
      source = candidate;
      break;
    } catch {}
  }
  if (!source) return;
  const imported = [];
  for (const [key, value] of Object.entries(parseLegacyEnv(text))) {
    if (await credentials.get(key)) continue;
    await credentials.set(key, value);
    imported.push(key);
  }
  if (imported.length) console.log(`[credentials] migrated ${imported.length} legacy entries from ${source}`);
}
function showWindow() { if (!win) return; win.show(); win.focus(); }

const rendererUrl = process.env.ELECTRON_RENDERER_URL || "";
// 只接受来自本应用页面的 IPC 调用，防止被导航到外部页面后滥用凭据接口。
function isTrustedSender(event) {
  const url = event?.senderFrame?.url || "";
  return url.startsWith("file://") || (rendererUrl && url.startsWith(rendererUrl));
}
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error("untrusted IPC sender");
    return fn(event, ...args);
  });
}

function trayIcon() {
  const image = nativeImage.createFromPath(join(__dirname, "assets", "tray.png"));
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 900, minWidth: 720, minHeight: 560,
    icon: join(__dirname, "assets", "icon.png"),
    // preload 只用 contextBridge/ipcRenderer，可在沙箱中运行；文件读取全部交给主进程。
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://") || (rendererUrl && url.startsWith(rendererUrl))) return;
    event.preventDefault();
  });
  win.on("close", (event) => { if (!quitting) { event.preventDefault(); win.hide(); } });
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(root, "dist", "desktop", "index.html"));
}

async function waitForGateway() {
  const tokenFile = process.env.PI_DESKTOP_TOKEN_FILE || join(root, "runtime", "desktop-session.token");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    // 网关进程已经退出（例如配置有误）就不必再等满 30 秒。
    if (gateway && !gateway.child) throw new Error("网关进程已退出，请检查运行设置后重启服务");
    try {
      const { port } = JSON.parse(await readFile(tokenFile, "utf8"));
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("网关重启超时，未能重新连接");
}

// 交给网关子进程的环境：系统环境变量 < 桌面端托管的默认路径 < 运行设置 < 加密凭据。
// 令牌文件等托管项始终以桌面端为准。
async function gatewayEnv(paths) {
  const managedDefaults = managedDefaultsFor(paths);
  return {
    ...managedDefaults,
    ...(await settings.toEnv()),
    ...(await credentials.toEnv()),
    PI_DESKTOP_TOKEN_FILE: paths.tokenFile,
    PI_DESKTOP_CONTROL: "true",
  };
}

function managedDefaultsFor({ runtimeDir, logsDir }) {
  return {
    PI_LOCK_FILE: join(logsDir, "gateway.lock"),
    PI_APPROVALS_FILE: join(runtimeDir, "approvals.json"),
    PI_CHECKPOINTS_FILE: join(runtimeDir, "checkpoints.json"),
    PI_DOMAIN_TASKS_FILE: join(runtimeDir, "domain-tasks.json"),
    PI_EVENTS_FILE: join(runtimeDir, "events.jsonl"),
    PI_LEGACY_TASKS_FILE: join(runtimeDir, "tasks.json"),
  };
}

// 系统环境变量里与配置目录相关的项，用于在设置页标注“来自系统环境变量”。
function systemEnvSnapshot() {
  const keys = new Set(catalogFields(envCatalog).map((field) => field.key));
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => keys.has(key) && value));
}

async function settingsSnapshot(paths) {
  const [values, secrets] = await Promise.all([settings.read(), credentials.status()]);
  const managed = { ...managedDefaultsFor(paths), PI_DESKTOP_TOKEN_FILE: paths.tokenFile, PI_DESKTOP_CONTROL: "true" };
  return describeSettings({ catalog: envCatalog, values, managed, systemEnv: systemEnvSnapshot(), secrets });
}

async function start() {
  const runtimeRoot = app.getPath("userData");
  const runtimeDir = join(runtimeRoot, "runtime");
  const logsDir = join(runtimeRoot, "logs");
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  const paths = { runtimeDir, logsDir, tokenFile: join(runtimeDir, "desktop-session.token") };
  process.env.PI_DESKTOP_TOKEN_FILE = paths.tokenFile;
  credentials = createCredentialStore({ file: join(runtimeRoot, "credentials.json"), safeStorage, isAllowedKey: (key) => isSecretKey(key, envCatalog) });
  settings = createSettingsStore({ file: join(runtimeRoot, "settings.json"), catalog: envCatalog, roleKeys });
  if (!safeStorage.isEncryptionAvailable()) console.error("[credentials] OS encryption unavailable; saved credentials cannot be read");
  await migrateLegacyCredentials((await settings.read()).MULTYAGENT_LEGACY_ENV_FILE);

  // 设置相关的 IPC 不依赖网关：即使某项配置导致网关起不来，也能在设置页改回来。
  handle("desktop:credentials:list", () => credentials.list());
  handle("desktop:credentials:status", () => credentials.status());
  handle("desktop:credentials:set", (_event, key, value) => credentials.set(key, value));
  handle("desktop:credentials:remove", (_event, key) => credentials.remove(key));
  handle("desktop:settings:get", () => settingsSnapshot(paths));
  // changes：{ KEY: value }。空字符串表示恢复默认（密钥则为删除）。先全部校验再保存。
  handle("desktop:settings:save", async (_event, changes = {}) => {
    const plain = {};
    const secrets = {};
    for (const [key, value] of Object.entries(changes || {})) {
      if (isSecretKey(key, envCatalog)) secrets[key] = value;
      else plain[key] = value;
    }
    if (Object.keys(plain).length) await settings.setMany(plain);
    for (const [key, value] of Object.entries(secrets)) await credentials.set(key, value);
    return settingsSnapshot(paths);
  });

  gateway = createGatewayProcess({ entry: join(root, "src", "index.js"), cwd: runtimeRoot, env: await gatewayEnv(paths) });
  gateway.start();
  // The renderer reads the session token immediately on load. Wait until the
  // gateway has published its token and health endpoint so first launch does
  // not look disconnected and force a manual service restart.
  try {
    await waitForGateway();
  } catch (error) {
    // 网关没起来时仍然打开窗口：界面会显示“连接失败”，用户可以去运行设置里修正配置后重启服务。
    console.error(`[desktop] ${error.message}`);
  }
  // 渲染进程运行在沙箱里，不能自己读令牌文件，由主进程读取后返回。
  handle("desktop:session", async () => {
    const { token, port } = JSON.parse(await readFile(paths.tokenFile, "utf8"));
    return { token, port };
  });
  handle("desktop:select-directory", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? "" : (result.filePaths[0] || "");
  });
  handle("desktop:open-file", async (_event, filePath, projectName) => {
    try {
      const { path: candidate } = await resolveProjectFile(runtimeRoot, projectName, filePath);
      const error = await shell.openPath(candidate);
      return error ? { opened: false, error } : { opened: true };
    } catch (error) {
      return { opened: false, error: String(error?.message || error) };
    }
  });
  // 重启时重新组装完整环境（托管路径 + 运行设置 + 凭据），新配置在此生效。
  handle("desktop:gateway:restart", async () => { await gateway.restart(await gatewayEnv(paths)); await waitForGateway(); win?.webContents.reload(); return { restarted: true }; });
  handle("desktop:window:show", () => showWindow());
  handle("desktop:app:quit", () => { quitting = true; app.quit(); });
  await createWindow();
  tray = new Tray(trayIcon()); tray.setToolTip("MultyAgent Agent 工作台");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "显示工作台", click: showWindow }, { type: "separator" }, { label: "退出", click: () => { quitting = true; app.quit(); } }])); tray.on("click", showWindow);
}
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(start).catch((error) => { console.error(error); app.quit(); });
}
app.on("before-quit", (event) => {
  quitting = true;
  if (gateway && !gatewayStopping) {
    event.preventDefault();
    gatewayStopping = true;
    void gateway.stop().finally(() => { tray?.destroy(); app.quit(); });
  } else tray?.destroy();
});
app.on("window-all-closed", () => { /* tray keeps the app alive until explicit exit */ });
