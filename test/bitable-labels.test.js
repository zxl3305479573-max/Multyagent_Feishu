import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BOARD_FIELD_SCHEMA, OWNER_LABELS, STAGE_LABELS, STATUS_LABELS } from "../src/domain/bitable-board.js";

test("board column names are Chinese", () => {
  for (const field of BOARD_FIELD_SCHEMA) {
    assert.match(field.name, /^[\u4e00-\u9fa5]+$/, `${field.name} must be Chinese`);
  }
});

test("owner labels mirror the agent registry display names", async () => {
  const config = JSON.parse(await readFile(new URL("../config/agents.json", import.meta.url), "utf8"));
  for (const agent of config.agents) {
    assert.equal(OWNER_LABELS[agent.key], agent.displayName, `${agent.key} label drifted from agents.json`);
  }
  assert.equal(Object.keys(OWNER_LABELS).length, config.agents.length);
});

test("status and stage labels are Chinese", () => {
  for (const [key, label] of Object.entries(STATUS_LABELS)) {
    assert.match(label, /^[\u4e00-\u9fa5]+$/, `status ${key} label must be Chinese`);
  }
  for (const [key, label] of Object.entries(STAGE_LABELS)) {
    assert.match(label, /^[\u4e00-\u9fa5]+$/, `stage ${key} label must be Chinese`);
  }
});

test("every status the reducer can emit has a Chinese label", () => {
  for (const status of ["received", "in_progress", "awaiting_approval", "paused", "completed", "failed"]) {
    assert.ok(STATUS_LABELS[status], `missing label for ${status}`);
  }
});
