import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function readEvents(file) {
  try { return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch { return []; }
}

async function readAppendedSince(file, offset) {
  let handle;
  try { handle = await open(file, "r"); } catch { return Buffer.alloc(0); }
  try {
    const { size } = await handle.stat();
    if (size <= offset) return Buffer.alloc(0);
    const buffer = Buffer.alloc(size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    return buffer;
  } finally {
    await handle.close();
  }
}

function eventProject(event, taskMap) {
  if (event?.project_name || event?.projectName) return event.project_name || event.projectName;
  const root = String(event?.task_id || event?.parent_task_id || "").split(":")[0];
  return taskMap.get(root) || null;
}

function artifactRefs(value, target = new Set()) {
  for (const path of value?.artifact_paths || value?.artifactPaths || []) if (typeof path === "string" && path.trim()) target.add(path.trim());
  return target;
}

export async function exportProjectSnapshot({ project, taskStore, eventsFile = "runtime/events.jsonl", outputFile } = {}) {
  const name = String(project || "").trim();
  if (!name) throw new Error("project is required");
  if (!taskStore?.list) throw new TypeError("project export requires taskStore");
  const tasks = (await taskStore.list()).filter((task) => task?.project_name === name);
  const taskMap = new Map(tasks.map((task) => [task.task_id, name]));
  const events = (await readEvents(eventsFile)).filter((event) => eventProject(event, taskMap) === name);
  const refs = events.reduce((set, event) => artifactRefs(event, set), new Set());
  for (const task of tasks) artifactRefs(task, refs);
  const snapshot = { schema_version: 1, project: name, generated_at: new Date().toISOString(), tasks, events, artifact_refs: [...refs].sort() };
  if (outputFile) {
    const target = resolve(outputFile);
    snapshot.output_file = target;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
  return snapshot;
}

export async function archiveProjectHistory({ project, eventsFile = "runtime/events.jsonl", archiveFile, keep = 1000 } = {}) {
  const name = String(project || "").trim();
  if (!name) throw new Error("project is required");
  // 记下读取时的文件长度：重写期间网关仍在追加事件，换文件前要把这段增量补上。
  const sizeAtRead = await stat(eventsFile).then((info) => info.size, () => 0);
  const events = await readEvents(eventsFile);
  const matching = events.filter((event) => (event.project_name || event.projectName) === name);
  const keepCount = Math.max(0, Number(keep) || 0);
  const archived = matching.slice(0, Math.max(0, matching.length - keepCount));
  const retained = new Set(archived);
  const remaining = events.filter((event) => !retained.has(event));
  const archiveTarget = resolve(archiveFile || `${eventsFile}.${name}.archive.jsonl`);
  if (archived.length) {
    await mkdir(dirname(archiveTarget), { recursive: true });
    await appendFile(archiveTarget, `${archived.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  }
  const target = resolve(eventsFile);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, remaining.length ? `${remaining.map((event) => JSON.stringify(event)).join("\n")}\n` : "", "utf8");
  const appended = await readAppendedSince(target, sizeAtRead);
  if (appended.length) await appendFile(temp, appended);
  await rename(temp, target);
  return { project: name, archived: archived.length, kept: matching.length - archived.length, archiveFile: archiveTarget };
}

export async function restoreProjectHistory({ project, eventsFile = "runtime/events.jsonl", archiveFile } = {}) {
  const name = String(project || "").trim();
  if (!name) throw new Error("project is required");
  const archiveTarget = resolve(archiveFile || `${eventsFile}.${name}.archive.jsonl`);
  const [archived, current] = await Promise.all([readEvents(archiveTarget), readEvents(eventsFile)]);
  const existingIds = new Set(current.map((event) => event.event_id).filter(Boolean));
  const restored = archived.filter((event) => !event.event_id || !existingIds.has(event.event_id));
  if (restored.length) {
    const target = resolve(eventsFile);
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, `${restored.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  }
  return { project: name, restored: restored.length, archiveFile: archiveTarget };
}
