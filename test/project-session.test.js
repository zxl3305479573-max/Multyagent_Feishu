import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { sessionDirFor, sessionFileBelongsToDir } from "../src/pi-agent.js";

test("Agent sessions are isolated by both project and role", () => {
  assert.match(sessionDirFor({ key: "frontend_developer" }, "alpha"), /runtime[\\/]sessions[\\/]alpha[\\/]frontend_developer$/);
  assert.match(sessionDirFor({ key: "frontend_developer" }, "beta"), /runtime[\\/]sessions[\\/]beta[\\/]frontend_developer$/);
  assert.notEqual(sessionDirFor({ key: "architect" }, "alpha"), sessionDirFor({ key: "frontend_developer" }, "alpha"));
});

test("unassigned legacy sessions are isolated from project sessions", () => {
  assert.match(sessionDirFor({ key: "frontend_developer" }, null), /runtime[\\/]sessions[\\/]unassigned[\\/]frontend_developer$/);
});

test("a persisted session from another project or agent cannot be reused", () => {
  const dir = sessionDirFor({ key: "architect" }, "alpha");
  assert.equal(sessionFileBelongsToDir(join(dir, "session.jsonl"), dir), true);
  assert.equal(sessionFileBelongsToDir(join(sessionDirFor({ key: "architect" }, "beta"), "session.jsonl"), dir), false);
  assert.equal(sessionFileBelongsToDir(join(sessionDirFor({ key: "tester" }, "alpha"), "session.jsonl"), dir), false);
});
