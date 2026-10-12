const { readFile, realpath, stat } = require("node:fs/promises");
const { join, resolve, relative, isAbsolute, sep } = require("node:path");

async function resolveProjectFile(runtimeRoot, projectName, filePath) {
  const project = String(projectName || "").trim();
  const requested = String(filePath || "").trim();
  if (!requested || !/^[a-z][a-z0-9-]{1,63}$/.test(project)) throw new Error("无效的项目或文件路径");
  let projectRoot = join(runtimeRoot, "workspace", project);
  try {
    const registry = JSON.parse(await readFile(join(runtimeRoot, "runtime", "projects.json"), "utf8"));
    const configured = registry?.projects?.[project]?.storagePath;
    if (configured) projectRoot = resolve(runtimeRoot, String(configured));
  } catch {}
  // Deliveries may contain runtime-relative or project-relative paths.
  const normalized = requested.replaceAll("\\", "/");
  const runtimeRelative = normalized.startsWith(`workspace/${project}/`);
  const candidate = isAbsolute(requested) ? resolve(requested)
    : runtimeRelative ? resolve(runtimeRoot, requested) : resolve(projectRoot, requested);
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(projectRoot), realpath(candidate)]);
  const inside = relative(canonicalRoot, canonicalFile);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error("文件不在当前项目目录内");
  }
  const info = await stat(canonicalFile);
  if (!info.isFile()) throw new Error("交付路径不是文件");
  return { path: canonicalFile, size: info.size };
}

module.exports = { resolveProjectFile };
