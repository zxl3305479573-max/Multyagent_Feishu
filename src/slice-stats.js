// 切片统计：从事件日志汇总每个切片的耗时、结果与规模，以及项目经理派发被粒度门禁打回的比例，
// 用来校准 PI_SLICE_MAX_* 阈值——例如验收标准多的切片是否明显更容易失败、更耗时。
// 数据来源：编排层的 slice_finished 事件与项目经理的 delivery_received 事件。

const SIZE_BUCKETS = {
  criteria_count: [[0, 1, "0-1 条"], [2, 3, "2-3 条"], [4, 5, "4-5 条"], [6, Infinity, "6 条以上"]],
  task_chars: [[0, 199, "200 字以内"], [200, 499, "200-499 字"], [500, 799, "500-799 字"], [800, Infinity, "800 字以上"]],
};

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function summarizeGroup(items) {
  const durations = items.map((item) => Number(item.duration_ms)).filter(Number.isFinite);
  const failed = items.filter((item) => item.status === "failed").length;
  return {
    count: items.length,
    completed: items.filter((item) => item.status === "completed").length,
    failed,
    cancelled: items.filter((item) => item.status === "cancelled").length,
    failure_rate: items.length ? Number((failed / items.length).toFixed(3)) : 0,
    median_duration_ms: median(durations),
    max_duration_ms: durations.length ? Math.max(...durations) : null,
  };
}

function bucketize(items, field) {
  return Object.fromEntries(SIZE_BUCKETS[field].map(([min, max, label]) => [label, summarizeGroup(items.filter((item) => {
    const value = Number(item[field] || 0);
    return value >= min && value <= max;
  }))]).filter(([, group]) => group.count));
}

/** @param {Array<Record<string, any>>} events @param {{ since?: number }} [options] */
export function summarizeSliceStats(events = [], { since = 0 } = {}) {
  const inRange = events.filter((event) => !since || Date.parse(event.timestamp || "") >= since);
  const slices = inRange.filter((event) => event.type === "slice_finished");
  const byRole = {};
  for (const item of slices) (byRole[item.agent || "unknown"] ||= []).push(item);
  const pmDeliveries = inRange.filter((event) => event.type === "delivery_received" && event.agent === "project_manager" && Object.prototype.hasOwnProperty.call(event, "slice_gate_rejected"));
  const rejected = pmDeliveries.filter((event) => event.slice_gate_rejected === true).length;
  return {
    total: summarizeGroup(slices),
    by_role: Object.fromEntries(Object.entries(byRole).map(([role, items]) => [role, summarizeGroup(items)])),
    by_criteria_count: bucketize(slices, "criteria_count"),
    by_task_chars: bucketize(slices, "task_chars"),
    parallel: { parallel: summarizeGroup(slices.filter((item) => Number(item.write_scope_count) > 0)), serial: summarizeGroup(slices.filter((item) => !Number(item.write_scope_count))) },
    slice_gate: {
      pm_deliveries: pmDeliveries.length,
      rejected,
      rejection_rate: pmDeliveries.length ? Number((rejected / pmDeliveries.length).toFixed(3)) : 0,
      passed_with_warnings: pmDeliveries.filter((event) => Number(event.granularity_warnings) > 0).length,
    },
  };
}
