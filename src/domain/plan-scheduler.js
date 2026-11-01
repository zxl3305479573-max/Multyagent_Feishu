export function readyPlanAssignments(plan, completed = [], started = []) {
  if (!plan || !Array.isArray(plan.stages)) return [];
  const done = new Set(completed);
  const active = new Set(started);
  for (const stage of plan.stages) {
    const assignments = Array.isArray(stage?.assignments) ? stage.assignments : [];
    const pending = assignments.filter((assignment) => assignment?.id && !done.has(assignment.id) && !active.has(assignment.id));
    if (!pending.length) continue;
    return pending.filter((assignment) => (assignment.dependsOn || []).every((dependency) => done.has(dependency)));
  }
  return [];
}

export function planProgress(plan, completed = []) {
  const assignments = (plan?.stages || []).flatMap((stage) => Array.isArray(stage?.assignments) ? stage.assignments : []);
  const done = new Set(completed);
  return assignments.length ? Math.round((assignments.filter((assignment) => done.has(assignment.id)).length / assignments.length) * 100) : 0;
}
