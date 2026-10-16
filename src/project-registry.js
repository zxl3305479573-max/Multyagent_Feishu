import { lstat, mkdir, readdir, symlink } from "node:fs/promises";
import { readJsonFile, writeFileAtomic } from "./atomic-file.cjs";
import { isAbsolute, join, resolve } from "node:path";

const PROJECT_NAME = /^[a-z][a-z0-9-]{1,63}$/;

function clone(value) { return value ? JSON.parse(JSON.stringify(value)) : value; }

export function createProjectRegistry({ file = "runtime/projects.json", root = process.cwd() } = {}) {
  const workspace = resolve(root, "workspace");
  let state = { projects: {} };
  let loaded = false;
  let writing = Promise.resolve();
  async function load() {
    if (loaded) return;
    state = (await readJsonFile(file, { fallback: () => ({ projects: {} }), onCorrupt: "throw" })) || { projects: {} };
    state.projects ||= {};
    loaded = true;
  }
  async function persist() {
    writing = writing.then(async () => {
      await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
    });
    await writing;
  }
  async function create({ name, storagePath } = {}) {
    await load();
    const projectName = String(name || "").trim().toLowerCase();
    if (!PROJECT_NAME.test(projectName)) throw new Error("projectName must be 2-64 chars, lowercase letters, numbers, or hyphens");
    const target = resolve(storagePath ? (isAbsolute(storagePath) ? storagePath : resolve(root, storagePath)) : join(workspace, projectName));
    if (target === resolve(root) || target === resolve(workspace)) throw new Error("project storage path is too broad");
    await mkdir(target, { recursive: true });
    const link = join(workspace, projectName);
    if (resolve(target) !== resolve(link)) {
      try {
        const info = await lstat(link);
        if (!info.isSymbolicLink()) throw new Error("workspace project path already exists");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await mkdir(workspace, { recursive: true });
        await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      }
    }
    const project = { name: projectName, storagePath: target, createdAt: state.projects[projectName]?.createdAt || new Date().toISOString() };
    state.projects[projectName] = project;
    await persist();
    return clone(project);
  }
  async function workspaceProjects() {
    try {
      const entries = await readdir(workspace, { withFileTypes: true });
      return entries.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && PROJECT_NAME.test(entry.name)).map((entry) => entry.name);
    } catch {
      return [];
    }
  }
  return {
    async list(extraNames = []) {
      await load();
      // 飞书端项目经理用 create_project 直接建 workspace/<项目名>，不经过注册表；把这些目录也列出来，
      // 桌面端才能看到飞书端创建的项目。
      const names = new Set([...Object.keys(state.projects), ...await workspaceProjects(), ...extraNames.map((name) => String(name || "").trim()).filter(Boolean)]);
      return [...names].sort().map((name) => clone(state.projects[name] || { name, storagePath: resolve(workspace, name) }));
    },
    create,
    get: async (name) => { await load(); return clone(state.projects[String(name || "").trim()]); },
  };
}
