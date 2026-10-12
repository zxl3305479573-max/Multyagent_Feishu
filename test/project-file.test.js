import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectFile } from "../src/project-file.cjs";
import { describeDeliveryArtifacts } from "../src/artifacts.js";

test("project files resolve both delivery path formats and reject traversal and external links", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-files-"));
  try {
    const project = join(root, "workspace", "demo");
    await mkdir(join(project, "artifacts"), { recursive: true });
    const file = join(project, "artifacts", "report.md");
    await writeFile(file, "report");
    for (const path of ["artifacts/report.md", "workspace/demo/artifacts/report.md", file]) {
      const result = await resolveProjectFile(root, "demo", path);
      assert.equal(result.path, await realpath(file));
      assert.equal(result.size, 6);
    }
    await writeFile(join(root, "outside.md"), "outside");
    await assert.rejects(resolveProjectFile(root, "demo", "../../outside.md"), /当前项目/);
    await assert.rejects(resolveProjectFile(root, "demo", "artifacts"), /不是文件/);
    await symlink(root, join(project, "escape"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(resolveProjectFile(root, "demo", "escape/outside.md"), /当前项目/);
    const items = await describeDeliveryArtifacts({ artifactPaths: ["artifacts/report.md", "artifacts/missing.md"], artifactItems: [{ path: "artifacts/report.md", description: "报告内容" }] }, { root, projectName: "demo" });
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], { path: "artifacts/report.md", description: "报告内容", type: "md", size: 6 });
    assert.equal(items[1].size, undefined);
    await mkdir(join(root, "runtime"));
    await writeFile(join(root, "runtime", "projects.json"), JSON.stringify({ projects: { demo: { storagePath: project } } }));
    assert.equal((await resolveProjectFile(root, "demo", file)).size, 6);
  } finally { await rm(root, { recursive: true, force: true }); }
});
