import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectRegistry } from "../src/project-registry.js";

test("project list includes workspace folders created from Feishu without the registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-registry-"));
  try {
    await mkdir(join(root, "workspace", "feishu-made"), { recursive: true });
    await mkdir(join(root, "workspace", "_tmp"), { recursive: true });
    const registry = createProjectRegistry({ file: join(root, "runtime", "projects.json"), root });
    await registry.create({ name: "desktop-made" });
    const names = (await registry.list(["from-task"])).map((project) => project.name);
    assert.deepEqual(names, ["desktop-made", "feishu-made", "from-task"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
