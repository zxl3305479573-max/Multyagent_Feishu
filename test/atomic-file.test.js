import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorruptStateFileError, readJsonFile, readJsonFileSync, writeFileAtomic, writeFileAtomicSync } from "../src/atomic-file.cjs";

function scratch() { return mkdtempSync(join(tmpdir(), "atomic-file-")); }

test("atomic writes replace content and leave no temp files", async () => {
  const dir = scratch();
  try {
    const file = join(dir, "nested", "state.json");
    await writeFileAtomic(file, JSON.stringify({ a: 1 }));
    writeFileAtomicSync(file, JSON.stringify({ a: 2 }));
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFileAtomic(file, JSON.stringify({ a: i }))));
    assert.equal(typeof JSON.parse(readFileSync(file, "utf8")).a, "number");
    assert.deepEqual(readdirSync(join(dir, "nested")), ["state.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing files return the fallback", async () => {
  const dir = scratch();
  try {
    assert.deepEqual(await readJsonFile(join(dir, "none.json"), { fallback: { x: 1 } }), { x: 1 });
    assert.deepEqual(readJsonFileSync(join(dir, "none.json"), { fallback: () => ({ y: 2 }) }), { y: 2 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt or empty files are backed up; throw mode refuses to continue", async () => {
  const dir = scratch();
  try {
    const file = join(dir, "state.json");
    writeFileSync(file, "");
    await assert.rejects(() => readJsonFile(file), CorruptStateFileError);
    writeFileSync(file, "{ half");
    assert.deepEqual(readJsonFileSync(file, { fallback: {}, onCorrupt: "backup", log: { warn() {} } }), {});
    assert.equal(readdirSync(dir).filter((name) => name.includes(".corrupt-")).length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
