import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const tokenCss = await readFile(join(root, "desktop/renderer/src/styles/tokens.css"), "utf8");
const contract = [...tokenCss.matchAll(/^\s*(--[\w-]+):/gm)].map((match) => match[1]);
const skinsDir = join(root, "desktop/renderer/src/themes/skins");
const animationSource = await readFile(join(root, "desktop/renderer/src/themes/animation.ts"), "utf8");
const skinTypes = await readFile(join(root, "desktop/renderer/src/themes/types.ts"), "utf8");
const defaultsSource = await readFile(join(root, "desktop/renderer/src/themes/defaults.ts"), "utf8");
const registrySource = await readFile(join(root, "desktop/renderer/src/themes/registry.ts"), "utf8");
const pearSource = await readFile(join(skinsDir, "pear/index.ts"), "utf8");

test("every skin covers the tokens.css contract", async () => {
  const entries = await readdir(skinsDir, { withFileTypes: true });
  const files = entries.flatMap((entry) =>
    entry.isFile() && entry.name.endsWith(".ts")
      ? [entry.name]
      : entry.isDirectory()
        ? [`${entry.name}/index.ts`]
        : [],
  );
  assert.ok(files.length >= 5, "at least five built-in skins are expected");
  for (const file of files) {
    const source = await readFile(join(skinsDir, file), "utf8");
    const defined = new Set([...source.matchAll(/"(--[\w-]+)"\s*:/g)].map((match) => match[1]));
    assert.deepEqual([...defined].sort(), [...contract].sort(), `${file} does not match tokens.css`);
  }
});

test("skins provide only tokens, assets and copy, never layout switches", async () => {
  assert.doesNotMatch(skinTypes, /SkinLayout|layout\?/);
  const entries = await readdir(skinsDir, { withFileTypes: true });
  const files = entries.flatMap((entry) =>
    entry.isFile() && entry.name.endsWith(".ts")
      ? [entry.name]
      : entry.isDirectory()
        ? [`${entry.name}/index.ts`]
        : [],
  );
  for (const file of files) {
    const source = await readFile(join(skinsDir, file), "utf8");
    assert.doesNotMatch(source, /homeThreeColumn|taskPanel|layout\s*:/, `${file} still defines a layout switch`);
  }
});

test("neutral brand, copy and asset fallbacks live in one resolver", () => {
  for (const field of ["displayName", "slogan", "welcomeText", "welcomeDescription", "quickEntries"]) {
    assert.match(defaultsSource, new RegExp(`\\b${field}\\s*:`), `default brand is missing ${field}`);
  }
  assert.match(defaultsSource, /Agent 工作台/);
  assert.match(defaultsSource, /resolveSkinDefinition/);
  assert.match(registrySource, /resolveSkinDefinition/);
});

test("Pear supplies the complete asset/copy contract and components do not branch on skin id", async () => {
  for (const slot of ["aiAvatar", "welcomeIllustration", "toolRobotIcon", "logo", "moods", "robots", "favicon"]) {
    assert.ok(
      pearSource.includes(`${slot}:`) || pearSource.includes(`${slot},`),
      `Pear is missing asset slot ${slot}`,
    );
  }
  assert.match(pearSource, /quickEntries\s*:/);
  const componentsDir = join(root, "desktop/renderer/src/components");
  const componentFiles = (await readdir(componentsDir)).filter((file) => file.endsWith(".tsx"));
  for (const file of componentFiles) {
    const source = await readFile(join(componentsDir, file), "utf8");
    assert.doesNotMatch(
      source,
      /skin\.id\s*===?\s*["']pear["']|skin\.layout/,
      `${file} still branches on the Pear layout`,
    );
  }
});

test("Pear character and robot states map to the existing static assets and animation adapter", () => {
  for (const state of ["idle", "thinking", "planning", "executing", "success", "error", "confirm"]) {
    assert.match(animationSource, new RegExp(`\\b${state}\\b`), `missing character state ${state}`);
  }
  for (const state of ["idle", "working", "loading", "error"]) {
    assert.match(animationSource, new RegExp(`\\b${state}\\b`), `missing robot state ${state}`);
  }
  assert.match(animationSource, /SkinAnimationAdapter/);
  assert.match(animationSource, /createRiveSkinAnimationAdapter/);
});
