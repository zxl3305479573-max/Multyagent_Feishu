const REQUIRED_FIELDS = [
  "task_id",
  "agent",
  "status",
  "summary",
  "artifacts",
  "evidence",
  "blockers",
  "assumptions",
  "risks",
  "next_action",
  "created_at",
];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createHandoff(input = {}) {
  const now = new Date().toISOString();
  return {
    task_id: input.task_id || input.taskId || null,
    agent: input.agent || null,
    status: input.status || "completed",
    summary: input.summary || "",
    artifacts: input.artifacts || [],
    evidence: input.evidence || [],
    blockers: input.blockers || [],
    assumptions: input.assumptions || [],
    risks: input.risks || [],
    next_action: input.next_action || input.nextAction || "",
    choices: Array.isArray(input.choices) ? input.choices : [],
    created_at: input.created_at || input.createdAt || now,
  };
}

export function validateHandoff(handoff) {
  const errors = [];
  if (!isObject(handoff)) return { valid: false, errors: ["handoff"] };

  for (const field of REQUIRED_FIELDS) {
    if (!(field in handoff) || (typeof handoff[field] === "string" && !handoff[field].trim())) {
      errors.push(field);
    }
  }

  for (const field of ["artifacts", "evidence", "blockers", "assumptions", "risks"]) {
    if (field in handoff && !Array.isArray(handoff[field])) errors.push(field);
  }
  if ("choices" in handoff && !Array.isArray(handoff.choices)) errors.push("choices");
  if (Array.isArray(handoff.choices)) {
    for (const choice of handoff.choices) {
      if (!isObject(choice) || !choice.id || !choice.label) { errors.push("choices"); break; }
    }
  }
  if (Array.isArray(handoff.evidence) && handoff.evidence.length === 0) {
    errors.push("evidence");
  }

  if (Array.isArray(handoff.artifacts)) {
    for (const artifact of handoff.artifacts) {
      if (!isObject(artifact) || !artifact.path || !artifact.type || !artifact.digest || !artifact.version) {
        errors.push("artifacts");
        break;
      }
    }
  }

  if (Array.isArray(handoff.evidence)) {
    for (const evidence of handoff.evidence) {
      if (!isObject(evidence) || !evidence.command || !evidence.result) {
        errors.push("evidence");
        break;
      }
    }
  }

  if (handoff.status && handoff.status !== "completed") errors.push("status");
  if (handoff.created_at && Number.isNaN(Date.parse(handoff.created_at))) errors.push("created_at");

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function assertHandoff(handoff) {
  const result = validateHandoff(handoff);
  if (!result.valid) {
    throw new Error(`交接包校验失败: ${result.errors.join(", ")}`);
  }
  return handoff;
}
