import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;
const tokenCss = await readFile(join(root, "desktop/renderer/src/styles/tokens.css"), "utf8");
const contract = [...tokenCss.matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]);
const skinsDir = join(root, "desktop/renderer/src/themes/skins");

test("每个皮肤完整覆盖 tokens.css 契约", async () => {
  const entries = await readdir(skinsDir, { withFileTypes: true });
  const files = entries.flatMap((entry) => entry.isFile() && entry.name.endsWith(".ts") ? [entry.name] : entry.isDirectory() ? [`${entry.name}/index.ts`] : []);
  assert.ok(files.length >= 5, "至少应有五个内置皮肤");
  for (const file of files) {
    const source = await readFile(join(skinsDir, file), "utf8");
    const defined = new Set([...source.matchAll(/"(--[\w-]+)"\s*:/g)].map((match) => match[1]));
    assert.deepEqual([...defined].sort(), [...contract].sort(), `${file} 的 token 集合与 tokens.css 不一致`);
  }
});
