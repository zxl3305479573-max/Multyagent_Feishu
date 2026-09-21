import { validateHandoff } from "./handoff.js";

export function auditDelivery(handoff, { allowedPaths = [], requireEvidence = true } = {}) {
  const validation = validateHandoff(handoff);
  const errors = [...validation.errors];
  if (requireEvidence && (!handoff?.evidence?.length)) errors.push("evidence");
  if (allowedPaths.length) {
    for (const artifact of handoff?.artifacts || []) {
      if (!allowedPaths.some((prefix) => artifact.path === prefix || artifact.path.startsWith(`${prefix}/`))) {
        errors.push(`artifact_path:${artifact.path}`);
      }
    }
  }
  return { passed: errors.length === 0, errors: [...new Set(errors)], checkedAt: new Date().toISOString() };
}

export function assertAudit(handoff, options) {
  const result = auditDelivery(handoff, options);
  if (!result.passed) {
    const error = new Error(`Audit gate failed: ${result.errors.join(", ")}`);
    error.audit = result;
    throw error;
  }
  return result;
}
