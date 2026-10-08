const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, safeStorage } = require("electron");
const { join } = require("node:path");
const { mkdir, readFile } = require("node:fs/promises");
const { createCredentialStore } = require("./credential-store.cjs");
const { createGatewayProcess } = require("./gateway-process.cjs");

const root = join(__dirname, "..", "..");
let win = null; let tray = null; let quitting = false; let gateway = null; let credentials = null; let gatewayStopping = false;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const LEGACY_CREDENTIAL_KEY = /^(?:FEISHU_[A-Z0-9_]+_(?:APP_ID|APP_SECRET)|DEEPSEEK_API_KEY|OPENAI_API_KEY)$/;
const LEGACY_ENV_FILES = [
  process.env.MULTYAGENT_LEGACY_ENV_FILE,
  join(root, ".env"),
  "D:\\33054\\Multyagent_Feishu\\.env",
].filter(Boolean);

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

async function migrateLegacyCredentials() {
  let source = "";
  let text = "";
  for (const candidate of LEGACY_ENV_FILES) {
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

async function createWindow() {
  win = new BrowserWindow({ width: 1320, height: 900, minWidth: 960, minHeight: 640, webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  win.on("close", (event) => { if (!quitting) { event.preventDefault(); win.hide(); } });
  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(join(root, "dist", "desktop", "index.html"));
}

async function waitForGateway() {
  const tokenFile = process.env.PI_DESKTOP_TOKEN_FILE || join(root, "runtime", "desktop-session.token");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const { port } = JSON.parse(await readFile(tokenFile, "utf8"));
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("网关重启超时，未能重新连接");
}

async function start() {
  const runtimeRoot = app.getPath("userData");
  const runtimeDir = join(runtimeRoot, "runtime");
  const logsDir = join(runtimeRoot, "logs");
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  process.env.PI_DESKTOP_TOKEN_FILE = join(runtimeRoot, "runtime", "desktop-session.token");
  credentials = createCredentialStore({ file: join(app.getPath("userData"), "credentials.json"), safeStorage });
  await migrateLegacyCredentials();
  const env = await credentials.toEnv();
  gateway = createGatewayProcess({
    entry: join(root, "src", "index.js"),
    cwd: runtimeRoot,
    env: {
      ...env,
      PI_DESKTOP_TOKEN_FILE: process.env.PI_DESKTOP_TOKEN_FILE,
      PI_LOCK_FILE: join(logsDir, "gateway.lock"),
      PI_APPROVALS_FILE: join(runtimeDir, "approvals.json"),
      PI_CHECKPOINTS_FILE: join(runtimeDir, "checkpoints.json"),
      PI_DOMAIN_TASKS_FILE: join(runtimeDir, "domain-tasks.json"),
      PI_EVENTS_FILE: join(runtimeDir, "events.jsonl"),
      PI_LEGACY_TASKS_FILE: join(runtimeDir, "tasks.json"),
    },
  });
  gateway.start();
  // The renderer reads the session token immediately on load. Wait until the
  // gateway has published its token and health endpoint so first launch does
  // not look disconnected and force a manual service restart.
  await waitForGateway();
  ipcMain.handle("desktop:credentials:list", () => credentials.list());
  ipcMain.handle("desktop:credentials:set", (_event, key, value) => credentials.set(key, value));
  ipcMain.handle("desktop:credentials:remove", (_event, key) => credentials.remove(key));
  ipcMain.handle("desktop:token-file", () => process.env.PI_DESKTOP_TOKEN_FILE);
  ipcMain.handle("desktop:select-directory", async () => {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? "" : (result.filePaths[0] || "");
  });
  ipcMain.handle("desktop:gateway:restart", async () => { await gateway.restart(await credentials.toEnv()); await waitForGateway(); win?.webContents.reload(); return { restarted: true }; });
  ipcMain.handle("desktop:window:show", () => showWindow());
  ipcMain.handle("desktop:app:quit", () => { quitting = true; app.quit(); });
  await createWindow();
  tray = new Tray(nativeImage.createEmpty()); tray.setToolTip("MultyAgent Agent 工作台");
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
