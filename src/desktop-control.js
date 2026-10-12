import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { readEventsTail } from "./event-log.js";

const isLoopback = (address = "") => address === "::1" || address === "127.0.0.1" || address.startsWith("::ffff:127.");

// 从日志尾部倒读，只取补发需要的部分，不再整文件读入。
async function replayEvents(file, cursor, project = null) {
  const filter = project ? (event) => event.project_name === project : null;
  const result = await readEventsTail(file, { limit: 1000, filter, cursor: cursor || null });
  return { events: result.events, reset: Boolean(cursor) && !result.cursorFound };
}

function scopedTask(task, project) {
  return !project || task?.project_name === project;
}

export function createDesktopControlServer({
  token,
  eventsFile = "runtime/events.jsonl",
  taskStore,
  agents = [],
  commandHandlers = {},
  listProjects = async (taskProjects = []) => [...new Set(taskProjects)].sort(),
  host = "127.0.0.1",
  port = 0,
} = {}) {
  if (typeof token !== "string" || token.length < 24) throw new Error("desktop control token must be at least 24 characters");
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("desktop control server must bind to loopback");

  const http = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set();
  const clientProjects = new Map();

  async function taskFor(taskId) {
    const root = String(taskId || "").split(":")[0];
    if (!root) return null;
    if (taskStore?.getRoot) return taskStore.getRoot(root);
    if (taskStore?.get) return taskStore.get(root);
    return (await taskStore?.list?.() || []).find((task) => task?.task_id === root) || null;
  }

  http.on("upgrade", (request, socket, head) => {
    if (!isLoopback(request.socket.remoteAddress) || request.url !== "/desktop") {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
  });

  wss.on("connection", (client) => {
    clients.add(client);
    let authenticated = false;
    client.on("message", async (buffer) => {
      let message;
      try { message = JSON.parse(buffer.toString()); }
      catch { client.close(1008, "invalid message"); return; }
      if (!authenticated) {
        if (message.type !== "auth" || message.token !== token) {
          client.close(1008, "unauthorized");
          return;
        }
        authenticated = true;
        clientProjects.set(client, message.project || null);
        try {
          const [allTasks, history] = await Promise.all([
            taskStore?.list?.() || [],
            replayEvents(eventsFile, message.cursor || null, message.project || null),
          ]);
          const tasks = allTasks.filter((task) => scopedTask(task, message.project || null));
          const taskProjects = allTasks.map((task) => task?.project_name).filter(Boolean);
          const projects = await listProjects(taskProjects);
          client.send(JSON.stringify({ type: "ready", tasks, projects, agents, project: message.project || null, cursor_reset: history.reset }));
          for (const event of history.events) {
            if (client.readyState !== WebSocket.OPEN) break;
            client.send(JSON.stringify({ type: "event", event }));
          }
        } catch {
          client.close(1011, "snapshot unavailable");
        }
        return;
      }
      if (message.type !== "command") return;
      if (message.token !== token) {
        client.close(1008, "unauthorized command");
        return;
      }
      const scopedProject = clientProjects.get(client);
      if (scopedProject && message.command !== "create_project") {
        const requestedProject = message.projectName || message.project || null;
        const task = message.taskId ? await taskFor(message.taskId) : null;
        const effectiveProject = requestedProject || task?.project_name || null;
        if (effectiveProject !== scopedProject) {
          client.send(JSON.stringify({ type: "command_result", requestId: message.requestId || null, command: message.command, error: "command project scope mismatch" }));
          return;
        }
      }
      const handler = commandHandlers[message.command];
      if (typeof handler !== "function") {
        client.send(JSON.stringify({ type: "command_result", requestId: message.requestId || null, error: "unsupported command" }));
        return;
      }
      try {
        const result = await handler(message);
      client.send(JSON.stringify({ type: "command_result", requestId: message.requestId || null, command: message.command, result }));
      } catch (error) {
        client.send(JSON.stringify({ type: "command_result", requestId: message.requestId || null, command: message.command, error: String(error?.message || error).slice(0, 500) }));
      }
    });
    client.on("close", () => { clients.delete(client); clientProjects.delete(client); });
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        http.once("error", onError);
        http.listen(port, host, () => {
          http.off("error", onError);
          resolve(http.address());
        });
      });
    },
    publish(event) {
      const message = JSON.stringify({ type: "event", event });
      for (const client of clients) if (client.readyState === WebSocket.OPEN && (!clientProjects.get(client) || clientProjects.get(client) === event?.project_name)) client.send(message);
    },
    close() {
      for (const client of clients) client.close(1001, "gateway stopping");
      return new Promise((resolve, reject) => {
        wss.close((wsError) => http.close((httpError) => (wsError || httpError) ? reject(wsError || httpError) : resolve()));
      });
    },
  };
}
