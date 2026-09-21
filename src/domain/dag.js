export function validateDag(tasks = []) {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const errors = [];
  for (const task of tasks) {
    for (const dependency of task.depends_on || []) {
      if (!byId.has(dependency)) errors.push(`${task.task_id}:missing:${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { errors.push(`cycle:${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on || []) if (byId.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.task_id);
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function readyTasks(tasks = []) {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  return tasks.filter((task) => task.status === "waiting_dependency" &&
    (task.depends_on || []).every((id) => ["succeeded", "completed"].includes(byId.get(id)?.status)));
}
