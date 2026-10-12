// 沙箱 preload：只能使用 contextBridge 与 ipcRenderer。令牌由主进程读取后经 IPC 返回，
// 渲染进程不接触文件系统，也拿不到 Node API。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  connect: async (project = "") => {
    const { token, port } = await ipcRenderer.invoke("desktop:session");
    const ws = new globalThis.WebSocket(`ws://127.0.0.1:${Number(port)}/desktop`);
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
  credentials: {
    list: () => ipcRenderer.invoke("desktop:credentials:list"),
    status: () => ipcRenderer.invoke("desktop:credentials:status"),
    set: (key, value) => ipcRenderer.invoke("desktop:credentials:set", key, value),
    remove: (key) => ipcRenderer.invoke("desktop:credentials:remove", key),
  },
  // 运行设置：读取全部配置项及生效值；保存时一次提交多项（密钥会加密保存）。
  settings: {
    get: () => ipcRenderer.invoke("desktop:settings:get"),
    save: (changes) => ipcRenderer.invoke("desktop:settings:save", changes),
  },
  restartGateway: () => ipcRenderer.invoke("desktop:gateway:restart"),
  selectDirectory: () => ipcRenderer.invoke("desktop:select-directory"),
  openFile: (filePath, projectName) => ipcRenderer.invoke("desktop:open-file", filePath, projectName),
  show: () => ipcRenderer.invoke("desktop:window:show"),
  quit: () => ipcRenderer.invoke("desktop:app:quit"),
});
