const { contextBridge, ipcRenderer } = require("electron");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

contextBridge.exposeInMainWorld("desktop", {
  connect: async (project = "") => {
    const configuredFile = await ipcRenderer.invoke("desktop:token-file").catch(() => "");
    const file = configuredFile || process.env.PI_DESKTOP_TOKEN_FILE || join(process.cwd(), "runtime", "desktop-session.token");
    const { token, port } = JSON.parse(await readFile(file, "utf8"));
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${port}/desktop`);
    await new Promise((resolve, reject) => {
      const onOpen = () => { ws.removeEventListener("error", onError); resolve(); };
      const onError = () => { ws.removeEventListener("open", onOpen); reject(new Error("WebSocket connection failed")); };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });
    const listeners = new Set(); const pending = [];
    ws.onmessage = (event) => { let value; try { value = JSON.parse(event.data); } catch { return; } if (!listeners.size) pending.push(value); else for (const listener of listeners) listener(value); };
    ws.send(JSON.stringify({ type: "auth", token, project: project || null }));
    return { send: (value) => ws.send(JSON.stringify({ ...value, token })), subscribe: (listener) => { listeners.add(listener); for (const value of pending.splice(0)) listener(value); return () => listeners.delete(listener); }, close: () => ws.close() };
  },
  credentials: { list: () => ipcRenderer.invoke("desktop:credentials:list"), set: (key, value) => ipcRenderer.invoke("desktop:credentials:set", key, value), remove: (key) => ipcRenderer.invoke("desktop:credentials:remove", key) },
  restartGateway: () => ipcRenderer.invoke("desktop:gateway:restart"),
  selectDirectory: () => ipcRenderer.invoke("desktop:select-directory"),
  openFile: (filePath, projectName) => ipcRenderer.invoke("desktop:open-file", filePath, projectName),
  show: () => ipcRenderer.invoke("desktop:window:show"),
  quit: () => ipcRenderer.invoke("desktop:app:quit"),
});
