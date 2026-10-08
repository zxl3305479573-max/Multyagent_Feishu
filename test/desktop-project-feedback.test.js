import test from "node:test";
import assert from "node:assert/strict";
import { formatProjectCommandFeedback } from "../src/desktop-project-feedback.js";

test("project export feedback includes output path and snapshot counts", () => {
  assert.equal(formatProjectCommandFeedback("export_project", { outputFile: "runtime/export.json", taskCount: 3, eventCount: 12 }), "项目已导出：runtime/export.json · 3 个任务 · 12 条事件");
});

test("history archive and restore feedback includes affected record counts", () => {
  assert.equal(formatProjectCommandFeedback("cleanup_history", { archived: 8, kept: 20 }), "历史已归档：归档 8 条，保留 20 条");
  assert.equal(formatProjectCommandFeedback("restore_history", { restored: 8 }), "历史已恢复：恢复 8 条记录");
});
