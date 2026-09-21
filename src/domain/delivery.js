import { createHandoff, validateHandoff } from "./handoff.js";
import { describeArtifact, saveArtifactMetadata, saveHandoff } from "../artifacts.js";

function evidenceFor(delivery) {
  if (Array.isArray(delivery?.evidence) && delivery.evidence.length) return delivery.evidence;
  return [{
    command: "agent delivery",
    result: delivery?.summary ? "passed" : "failed",
    details: delivery?.summary || "Agent returned no delivery summary",
  }];
}

export async function buildValidatedHandoff(delivery, { taskId, agent, artifactsDir, root = process.cwd() } = {}) {
  const supplied = delivery?.handoff || delivery;
  const paths = Array.isArray(supplied?.artifactPaths)
    ? supplied.artifactPaths
    : Array.isArray(supplied?.artifacts) ? supplied.artifacts.map((a) => a.path) : [];
  const artifacts = Array.isArray(supplied?.artifacts) && supplied.artifacts.every((a) => a?.digest && a?.version)
    ? supplied.artifacts
    : await Promise.all(paths.map(async (path) => {
      try { return await describeArtifact(path, { root }); }
      catch { return { path, type: "reference", digest: "sha256:unavailable", version: "unverified" }; }
    }));
  const handoff = createHandoff({
    ...supplied,
    task_id: taskId,
    agent: supplied?.agent || agent,
    status: supplied?.status || "completed",
    summary: supplied?.summary || "",
    artifacts,
    evidence: evidenceFor(supplied),
    next_action: supplied?.next_action || supplied?.next || "",
    choices: Array.isArray(supplied?.choices) ? supplied.choices : [],
  });
  const result = validateHandoff(handoff);
  if (!result.valid) {
    const error = new Error(`Invalid handoff: ${result.errors.join(", ")}`);
    error.code = "INVALID_HANDOFF";
    error.validation = result;
    throw error;
  }
  if (artifactsDir) {
    await saveHandoff(artifactsDir, handoff);
    await saveArtifactMetadata(artifactsDir, {
      taskId,
      agent,
      artifacts,
      evidence: handoff.evidence,
      changedFiles: artifacts.map((item) => item.path),
    });
  }
  return handoff;
}
