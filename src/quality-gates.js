// 质量完成度：把“代码写完”和“真正可交付”分开，并持久化到任务快照。

export const QUALITY_STAGES = ["implementation", "self_test", "independent_acceptance", "audit", "product"];

export const QUALITY_LABELS = {
  implementation: "实现",
  self_test: "开发自测",
  independent_acceptance: "独立验收",
  audit: "独立审计",
  product: "产品闭环",
};

const STATUS_LABELS = {
  pending: "待完成",
  in_progress: "进行中",
  ready_to_settle: "等待结算",
  passed: "已通过",
  failed: "未通过",
  reference_only: "仅供记录",
  not_required: "不适用",
};

export function qualityStatusLabel(status) {
  return STATUS_LABELS[status] || status;
}

export function requestsQualitySkip(description = "") {
  const text = String(description || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (/(?:不要|不得|不能|不允许|禁止).{0,8}(?:跳过|免除|不做)/i.test(text)) return false;
  const skip = "(?:跳过|免除|不做|不需要|无需(?:做)?|不用(?:做)?)";
  const test = "(?:测试|验收)";
  const audit = "(?:审计|安全审计)";
  const joined = "(?:和|与|以及|、|及)";
  return new RegExp(`${skip}.{0,20}${test}.{0,20}${audit}`, "i").test(text)
    || new RegExp(`${skip}.{0,20}${audit}.{0,20}${test}`, "i").test(text)
    || new RegExp(`${test}${joined}${audit}.{0,12}${skip}`, "i").test(text)
    || /(?:skip|omit|bypass).{0,20}(?:test(?:ing)?|acceptance).{0,20}(?:audit|security review)/i.test(text)
    || /(?:skip|omit|bypass).{0,20}(?:audit|security review).{0,20}(?:test(?:ing)?|acceptance)/i.test(text);
}

export function withQualitySkip(policy = {}) {
  return {
    ...policy,
    implementationRequired: policy.implementationRequired === true || policy.independentAcceptance === true || policy.acceptanceMatrix === true,
    independentAcceptance: false,
    acceptanceMatrix: false,
    e2e: false,
    audit: false,
    selfTestReference: false,
    skipTestingAndAudit: true,
    requiredEvidence: [],
  };
}

export function qualityPolicyForTask({ team = true, singleRole = false, mode = "auto", description = "" } = {}) {
  const functional = team && !singleRole && mode !== "ask";
  const text = String(description || "");
  const skipTestingAndAudit = functional && requestsQualitySkip(text);
  const e2e = functional && /(前端|页面|界面|浏览器|注册|登录|UI|前端开发|web)/i.test(text);
  const policy = {
    implementationRequired: functional,
    independentAcceptance: functional && !skipTestingAndAudit,
    acceptanceMatrix: functional && !skipTestingAndAudit,
    e2e: functional && !skipTestingAndAudit && e2e,
    audit: functional && !skipTestingAndAudit,
    selfTestReference: false,
    skipTestingAndAudit,
    requiredEvidence: functional && !skipTestingAndAudit ? ["typecheck", "test", "build", ...(e2e ? ["e2e"] : [])] : [],
  };
  return skipTestingAndAudit ? withQualitySkip(policy) : policy;
}

export function createQualityGates(policy = {}) {
  const functional = policy.implementationRequired === true
    || policy.independentAcceptance === true
    || policy.acceptanceMatrix === true
    || policy.skipTestingAndAudit === true;
  return {
    policy: {
      implementationRequired: functional,
      independentAcceptance: policy.independentAcceptance === true,
      acceptanceMatrix: policy.acceptanceMatrix === true,
      e2e: policy.e2e === true,
      audit: policy.audit === true,
      selfTestReference: false,
      skipTestingAndAudit: policy.skipTestingAndAudit === true,
      requiredEvidence: Array.isArray(policy.requiredEvidence) ? [...new Set(policy.requiredEvidence.map(String))] : [],
    },
    implementation: functional ? "pending" : "not_required",
    self_test: functional && policy.skipTestingAndAudit !== true ? "reference_only" : "not_required",
    independent_acceptance: policy.independentAcceptance ? "pending" : "not_required",
    audit: policy.audit ? "pending" : "not_required",
    acceptance_matrix: [],
    product: "incomplete",
    evidence: [],
  };
}

function clip(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function addEvidence(gates, evidence) {
  return [...(Array.isArray(gates.evidence) ? gates.evidence : []), evidence].slice(-80);
}

/** Reset only per-turn quality stages; policy and project-level evidence stay on the task. */
export function resetQualityGates(gates = {}) {
  const functional = gates.policy?.implementationRequired === true
    || gates.policy?.independentAcceptance === true
    || gates.policy?.acceptanceMatrix === true
    || gates.policy?.skipTestingAndAudit === true;
  return {
    ...gates,
    implementation: functional ? "pending" : "not_required",
    self_test: functional && gates.policy?.skipTestingAndAudit !== true ? "reference_only" : "not_required",
    independent_acceptance: gates.policy?.independentAcceptance ? "pending" : "not_required",
    audit: gates.policy?.audit ? "pending" : "not_required",
    acceptance_matrix: [],
    product: "incomplete",
  };
}

export function reduceQualityGates(gates, event = {}) {
  const current = gates || createQualityGates();
  const next = {
    ...current,
    policy: { ...(current.policy || {}) },
    evidence: Array.isArray(current.evidence) ? [...current.evidence] : [],
  };
  if (event.type === "task_reopened") return resetQualityGates(next);
  if (event.type === "task_started") {
    if ((next.policy?.independentAcceptance || next.policy?.acceptanceMatrix) && !["passed", "failed"].includes(next.implementation)) next.implementation = "in_progress";
    return next;
  }
  if (event.type === "task_plan_completed") {
    next.implementation = "passed";
    next.evidence = addEvidence(next, { kind: "implementation", status: "passed", at: event.timestamp || null });
    return next;
  }
  if (event.type === "task_plan_created" && Array.isArray(event.acceptance_matrix)) {
    next.acceptance_matrix = event.acceptance_matrix;
    return next;
  }
  if (event.type === "test_result") {
    if (!["frontend_developer", "backend_developer", "architect"].includes(event.agent)) return next;
    const status = event.status === "failed" ? "failed" : "passed";
    next.self_test = status;
    next.evidence = addEvidence(next, {
      kind: "self_test",
      status,
      agent: event.agent || null,
      command: clip(event.command, 500),
      at: event.timestamp || null,
    });
    return next;
  }
  if (event.type === "acceptance_submitted") {
    if (event.agent !== "tester") return next;
    next.independent_acceptance = event.verdict === "pass" ? "passed" : event.verdict === "fail" ? "failed" : "not_required";
    next.evidence = addEvidence(next, {
      kind: "independent_acceptance",
      status: next.independent_acceptance,
      agent: event.agent || "tester",
      verdict: event.verdict || null,
      checks: Array.isArray(event.checks) ? event.checks.length : 0,
      check_results: Array.isArray(event.checks) ? event.checks : [],
      failed_checks: event.failed_checks || [],
      evidence: Array.isArray(event.evidence) ? event.evidence : [],
      at: event.timestamp || null,
    });
    return next;
  }
  if (event.type === "delivery_received" && event.agent === "auditor") {
    const blockers = Array.isArray(event.blockers) ? event.blockers : [];
    next.audit = blockers.length ? "failed" : "passed";
    next.evidence = addEvidence(next, {
      kind: "audit",
      status: next.audit,
      agent: "auditor",
      summary: clip(event.summary, 1000),
      blockers,
      at: event.timestamp || null,
    });
    return next;
  }
  if (event.type === "task_settle") {
    const required = [
      next.implementation,
      next.independent_acceptance,
      next.audit,
    ];
    const valid = required.every((status) => status === "passed" || status === "not_required");
    next.product = valid ? "passed" : "incomplete";
    if (valid) next.evidence = addEvidence(next, { kind: "product", status: "passed", at: event.timestamp || null });
  }
  return next;
}

export function qualityGateReady(gates = {}) {
  return [
    gates.implementation,
    gates.independent_acceptance,
    gates.audit,
  ].every((status) => status === "passed" || status === "not_required");
}

export function qualityGateSummary(gates = {}) {
  return {
    implementation: gates.implementation || "pending",
    self_test: gates.self_test || "pending",
    independent_acceptance: gates.independent_acceptance || "pending",
    audit: gates.audit || "not_required",
    product: gates.product || "incomplete",
  };
}

/** Validate the plan-level acceptance matrix required before implementation starts. */
export function validateAcceptanceMatrix(matrix, assignments = []) {
  const errors = [];
  const items = Array.isArray(matrix) ? matrix : [];
  if (!items.length) errors.push("缺少 acceptanceMatrix；开发前必须逐项定义验收矩阵");
  const assignmentIds = new Set((assignments || []).flatMap((item) => [item.id, item.agentKey]).filter(Boolean));
  const seen = new Set();
  const normalized = items.slice(0, 50).map((item, index) => {
    const id = clip(item?.id || `AC${index + 1}`, 40);
    const criterion = clip(item?.criterion || item?.title, 300);
    const verifier = clip(item?.verifier, 60);
    const method = clip(item?.method, 20);
    const evidence = clip(item?.evidence, 300);
    const returnTo = clip(item?.returnTo, 60);
    if (!id) errors.push(`验收矩阵第 ${index + 1} 项缺少 id`);
    else if (seen.has(id)) errors.push(`验收矩阵存在重复 id：${id}`);
    seen.add(id);
    if (!criterion) errors.push(`${id} 缺少 criterion`);
    if (!["tester", "auditor"].includes(verifier)) errors.push(`${id} 的 verifier 必须是 tester 或 auditor；开发角色和项目经理的自测不能作为最终验收`);
    if (!["automated", "manual"].includes(method)) errors.push(`${id} 的 method 只能是 automated 或 manual`);
    if (!evidence) errors.push(`${id} 缺少 evidence 说明`);
    if (!["tester", "auditor", "project_manager", "frontend_developer", "backend_developer"].includes(returnTo)) errors.push(`${id} 的 returnTo 非法`);
    if (returnTo && assignmentIds.size && !assignmentIds.has(returnTo)) errors.push(`${id} 的 returnTo 不在本计划角色中`);
    return { id, criterion, verifier, method, evidence, returnTo };
  });
  return { valid: errors.length === 0, errors, matrix: normalized };
}

export function missingAcceptanceEvidence(acceptance = {}, requiredEvidence = []) {
  const evidence = Array.isArray(acceptance.evidence) ? acceptance.evidence : [];
  const patterns = {
    typecheck: /(typecheck|tsc(?:\s|$|--))/i,
    test: /(npm\s+(?:run\s+)?test|vitest|jest|playwright\s+test|pytest|node\s+--test)/i,
    build: /(npm\s+run\s+build|vite\s+build|(?:^|\s)build(?:\s|$))/i,
    e2e: /(playwright|e2e|cypress|browser|浏览器)/i,
  };
  return (Array.isArray(requiredEvidence) ? requiredEvidence : []).filter((kind) => {
    if (kind === "e2e" && evidence.some((item) => item.kind === "screenshot")) return false;
    const pattern = patterns[kind] || new RegExp(String(kind), "i");
    const matching = evidence.filter((item) => pattern.test([item.command, item.text, item.path, item.url].filter(Boolean).join(" ")));
    return !matching.some((item) => Number(item.exitCode ?? item.exit_code) === 0);
  });
}

/** Match the tester's structured checks to the plan's acceptance matrix. */
export function evaluateAcceptanceMatrix(matrix = [], acceptance = {}) {
  const checks = Array.isArray(acceptance.checks) ? acceptance.checks : [];
  const byId = new Map(checks.map((check) => [String(check.id || "").trim().toLowerCase(), check]));
  const results = (Array.isArray(matrix) ? matrix : []).map((item) => {
    const check = byId.get(String(item.id || "").trim().toLowerCase()) || null;
    const status = String(check?.status || "missing").trim().toLowerCase();
    return {
      id: item.id,
      criterion: item.criterion,
      verifier: item.verifier,
      status,
      detail: check?.detail || "",
    };
  });
  return {
    results,
    passed: results.filter((item) => item.status === "pass").length,
    failed: results.filter((item) => item.status === "fail").length,
    uncovered: results.filter((item) => !["pass", "fail"].includes(item.status)).map((item) => item.id),
    failedIds: results.filter((item) => item.status === "fail").map((item) => item.id),
    valid: results.length > 0 && results.every((item) => item.status === "pass"),
  };
}

/** Resolve failed AC ids to the returnTo owner declared before development. */
export function acceptanceFailureRouting(matrix = [], acceptance = {}) {
  const failedIds = new Set((Array.isArray(acceptance.checks) ? acceptance.checks : [])
    .filter((check) => String(check.status || "").toLowerCase() === "fail")
    .map((check) => String(check.id || "").trim().toLowerCase())
    .filter(Boolean));
  return (Array.isArray(matrix) ? matrix : [])
    .filter((item) => failedIds.has(String(item.id || "").trim().toLowerCase()))
    .map((item) => ({ id: item.id, criterion: item.criterion, returnTo: item.returnTo }));
}

/**
 * A multi-slice plan needs one independently executed integration-verification
 * slice. It must be the tester, depend on every work slice, and be explicitly
 * marked so the orchestrator does not infer it from free text.
 */
export function validateIntegrationSlice(assignments = []) {
  const items = (Array.isArray(assignments) ? assignments : []).filter(Boolean);
  if (items.length <= 1) return { valid: true, errors: [], integration: null };
  const integrations = items.filter((item) => item.integration === true);
  const errors = [];
  if (integrations.length !== 1) errors.push("多切片计划必须且只能有一个 integration=true 的集成验证切片");
  const integration = integrations[0] || null;
  if (integration) {
    if (integration.agentKey !== "tester") errors.push("集成验证切片必须由 tester 独立执行");
    const required = items.filter((item) => item !== integration && item.id).map((item) => item.id);
    const dependencies = new Set(integration.dependsOn || []);
    const missing = required.filter((id) => !dependencies.has(id));
    if (missing.length) errors.push(`集成验证切片必须依赖全部工作切片：${missing.join("、")}`);
  }
  return { valid: errors.length === 0, errors, integration };
}
