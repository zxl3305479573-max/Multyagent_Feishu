import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { artifactsDirFor, artifactPathSegment } from "../src/artifacts.js";

test("artifactPathSegment removes Windows-invalid task-id characters", () => {
  assert.equal(artifactPathSegment("TASK-1:tester:project_manager"), "TASK-1_tester_project_manager");
  assert.equal(artifactsDirFor("TASK-1:tester", "student"), join("workspace", "student", "artifacts", "TASK-1_tester"));
});
