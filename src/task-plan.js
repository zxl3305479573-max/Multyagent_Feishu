const PROJECT_SLUG = /^[a-z][a-z0-9-]*$/;
// 一份计划的切片总数上限：拆得过细会让派发轮次和汇总成本失控。
export const MAX_PLAN_ASSIGNMENTS = Number(process.env.PI_MAX_PLAN_ASSIGNMENTS) || 12;

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string").map((item) => item.trim()) : [];
}

function pathWithin(path, roots) {
  const candidate = path.replaceAll("\\", "/").replace(/\/$/, "");
  return roots.some((root) => {
    const base = root.replaceAll("\\", "/").replace(/\/$/, "");
    return candidate === base || candidate.startsWith(`${base}/`);
  });
}

function unique(values) {
  return new Set(values).size === values.length;
}

export function validateTaskPlan(input, { projectName, roleLimits = {} } = {}) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, errors: ["plan must be an object"], plan: null };
  }
  if (!PROJECT_SLUG.test(String(input.project || ""))) errors.push("project must be a lowercase project slug");
  if (projectName && input.project !== projectName) errors.push("plan project does not match the task project");
  if (typeof input.goal !== "string" || !input.goal.trim()) errors.push("goal is required");
  if (!Array.isArray(input.stages) || input.stages.length === 0) errors.push("at least one stage is required");
  const totalAssignments = (Array.isArray(input.stages) ? input.stages : []).reduce((sum, stage) => sum + (Array.isArray(stage?.assignments) ? stage.assignments.length : 0), 0);
  if (totalAssignments > MAX_PLAN_ASSIGNMENTS) errors.push(`plan has ${totalAssignments} assignments; keep it within ${MAX_PLAN_ASSIGNMENTS} slices`);

  const seenStages = new Set();
  const assignments = new Map();
  const assignmentLocations = new Map();
  const resultStages = [];
  for (const [stageIndex, stage] of (Array.isArray(input.stages) ? input.stages : []).entries()) {
    for (const assignment of Array.isArray(stage?.assignments) ? stage.assignments : []) {
      const id = String(assignment?.id || "").trim();
      if (id && !assignmentLocations.has(id)) assignmentLocations.set(id, stageIndex);
    }
  }
  for (const [stageIndex, stage] of (Array.isArray(input.stages) ? input.stages : []).entries()) {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      errors.push(`stage ${stageIndex + 1} must be an object`);
      continue;
    }
    const stageId = String(stage.id || "").trim();
    if (!stageId) errors.push(`stage ${stageIndex + 1} requires an id`);
    else if (seenStages.has(stageId)) errors.push(`duplicate stage id: ${stageId}`);
    seenStages.add(stageId);
    if (!Array.isArray(stage.assignments) || stage.assignments.length === 0) errors.push(`stage ${stageId || stageIndex + 1} requires assignments`);
    const resultAssignments = [];
    for (const assignment of Array.isArray(stage.assignments) ? stage.assignments : []) {
      if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) {
        errors.push(`stage ${stageId || stageIndex + 1} contains an invalid assignment`);
        continue;
      }
      const id = String(assignment.id || "").trim();
      const agentKey = String(assignment.agentKey || "").trim();
      if (!id) errors.push("assignment id is required");
      else if (assignments.has(id)) errors.push(`duplicate assignment id: ${id}`);
      if (!agentKey || !roleLimits[agentKey]) errors.push(`unknown agent role: ${agentKey || "(empty)"}`);
      if (typeof assignment.task !== "string" || !assignment.task.trim()) errors.push(`assignment ${id || "(empty)"} requires a task`);
      const deps = stringList(assignment.dependsOn);
      for (const dep of deps) {
        const dependencyStage = assignmentLocations.get(dep);
        if (dependencyStage === undefined) errors.push(`assignment ${id} has unknown dependency: ${dep}`);
        else if (dependencyStage >= stageIndex) errors.push(`assignment ${id} dependency ${dep} must be in a prior stage`);
      }

      const requestedTools = stringList(assignment.toolAllowlist);
      const requestedReads = stringList(assignment.fileReadAllowlist);
      const requestedWrites = stringList(assignment.fileWriteAllowlist);
      const limits = roleLimits[agentKey] || {};
      for (const tool of requestedTools) if (!stringList(limits.tools).includes(tool)) errors.push(`assignment ${id} requests tool outside role limit: ${tool}`);
      for (const path of requestedReads) if (!pathWithin(path, stringList(limits.readPaths))) errors.push(`assignment ${id} read path outside role limit: ${path}`);
      for (const path of requestedWrites) if (!pathWithin(path, stringList(limits.writePaths))) errors.push(`assignment ${id} write path outside role limit: ${path}`);
      const networkPolicy = assignment.networkPolicy && typeof assignment.networkPolicy === "object" ? assignment.networkPolicy : {};
      const domains = stringList(networkPolicy.domains).map((domain) => domain.toLowerCase());
      const allowedDomains = stringList(limits.networkDomains).map((domain) => domain.toLowerCase());
      if (networkPolicy.enabled === true && limits.networkAccess !== true) errors.push(`assignment ${id} requests network access outside role limit`);
      for (const domain of domains) if (!allowedDomains.includes(domain)) errors.push(`assignment ${id} requests network domain outside role limit: ${domain}`);
      if (networkPolicy.enabled === true && domains.length === 0) errors.push(`assignment ${id} network access requires explicit domains`);
      if (!unique(requestedTools)) errors.push(`assignment ${id} has duplicate tools`);
      if (!unique(deps)) errors.push(`assignment ${id} has duplicate dependencies`);

      const normalized = {
        id,
        agentKey,
        task: String(assignment.task || "").trim(),
        dependsOn: deps,
        toolAllowlist: requestedTools,
        fileReadAllowlist: requestedReads,
        fileWriteAllowlist: requestedWrites,
        networkPolicy: { enabled: networkPolicy.enabled === true, domains },
        acceptanceCriteria: stringList(assignment.acceptanceCriteria),
        approvalRequired: assignment.approvalRequired !== false,
      };
      if (id) assignments.set(id, { stageIndex, assignment: normalized });
      resultAssignments.push(normalized);
    }
    resultStages.push({ id: stageId, assignments: resultAssignments });
  }

  return {
    valid: errors.length === 0,
    errors,
    plan: errors.length === 0 ? {
      project: input.project,
      goal: input.goal.trim(),
      stages: resultStages,
      acceptanceCriteria: stringList(input.acceptanceCriteria),
    } : null,
  };
}
