import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDataDir } from "../src/data-dir.js";

test("PI_DATA_DIR switches the gateway working directory and expands %VAR%", async () => {
  const base = await mkdtemp(join(tmpdir(), "data-dir-"));
  const original = process.cwd();
  try {
    assert.equal(applyDataDir({}), null);
    const target = applyDataDir({ PI_DATA_DIR: "%BASE%/shared", BASE: base });
    assert.equal(target, join(base, "shared"));
    assert.equal(await realpath(process.cwd()), await realpath(target));
  } finally {
    process.chdir(original);
    await rm(base, { recursive: true, force: true });
  }
});
