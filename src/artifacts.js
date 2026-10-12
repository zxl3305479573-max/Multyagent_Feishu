// 产物仓库：runtime/artifacts/<task_id>/ 下的交付物与交付包落盘。
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-file.cjs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveProjectFile } from "./project-file.cjs";

// 产物目录：项目内 workspace/<项目名>/artifacts/<task_id>/（未指定项目时用 default）。
// 子任务 ID 使用冒号分隔层级，但 Windows 不允许冒号出现在目录名中。
export function artifactPathSegment(value) {
  return String(value || "unknown").replace(/[<>:\"/\\|?*]/g, "_");
}

export function artifactsDirFor(taskId, projectName) {
  const project = projectName || "default";
  return join("workspace", project, "artifacts", artifactPathSegment(taskId));
}

export async function describeDeliveryArtifacts(delivery, { root = process.cwd(), projectName = delivery.projectName } = {}) {
  const items = new Map();
  const keyFor = (path) => String(path).replaceAll("\\", "/");
  for (const path of delivery.artifactPaths || []) {
    if (path) items.set(keyFor(path), { path, description: "" });
  }
  for (const item of delivery.artifactItems || []) {
    if (item?.path) items.set(keyFor(item.path), { ...items.get(keyFor(item.path)), ...item });
  }
  return Promise.all([...items.values()].map(async (item) => {
    const type = extname(item.path).slice(1).toLowerCase() || "file";
    try {
      const { size } = await resolveProjectFile(root, projectName, item.path);
      return { path: item.path, description: item.description || "", type, size };
    } catch {
      return { path: item.path, description: item.description || "", type };
    }
  }));
}

export async function ensureArtifactsDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

// 交付包落盘：<artifactsDir>/<agentKey>-delivery.json
export async function saveDelivery(artifactsDir, agentKey, delivery) {
  await ensureArtifactsDir(artifactsDir);
  const file = join(artifactsDir, `${agentKey}-delivery.json`);
  await writeFileAtomic(file, JSON.stringify({ ...delivery, agentKey, deliveredAt: Date.now() }, null, 2));
  return file;
}

export async function digestFile(file) {
  const data = await readFile(file);
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export async function describeArtifact(path, { root = process.cwd(), type = "file", version = "working-tree" } = {}) {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`Artifact is not a file: ${path}`);
  return {
    path: relative(root, absolute).replaceAll("\\", "/"),
    type,
    digest: await digestFile(absolute),
    version,
  };
}

export async function saveArtifactMetadata(artifactsDir, { taskId, agent, artifacts = [], evidence = [], changedFiles = [] } = {}) {
  await ensureArtifactsDir(artifactsDir);
  const metadata = {
    task_id: taskId || null,
    agent: agent || null,
    artifacts,
    evidence,
    changed_files: changedFiles,
    created_at: new Date().toISOString(),
  };
  const files = {
    "changed-files.json": changedFiles,
    "evidence.json": evidence,
    "artifact-metadata.json": metadata,
  };
  await Promise.all(Object.entries(files).map(([name, value]) =>
    writeFile(join(artifactsDir, name), JSON.stringify(value, null, 2))));
  return metadata;
}

export async function saveHandoff(artifactsDir, handoff) {
  await ensureArtifactsDir(artifactsDir);
  await writeFile(join(artifactsDir, "handoff.json"), JSON.stringify(handoff, null, 2));
  await writeFile(join(artifactsDir, "summary.md"), `${handoff.summary}\n`);
  return join(artifactsDir, "handoff.json");
}
