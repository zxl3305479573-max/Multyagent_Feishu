// @ts-check
// 工单优先级：GitHub 没有内置优先级字段，按常见标签约定推断（P0/P1、priority: high、紧急/严重/高 等）。
// rank 越小越紧急；没有任何优先级标签时为 50，bug 标签本身不改变优先级。

const LEVELS = [
  { rank: 0, label: "紧急", pattern: /(?:^|[\s:/-])(?:p0|s0|urgent|critical|blocker)$|紧急|严重|阻塞/ },
  { rank: 10, label: "高", pattern: /(?:^|[\s:/-])(?:p1|s1|high|major)$|高优|^高$|优先级[:：]?\s*高|主要/ },
  { rank: 20, label: "中", pattern: /(?:^|[\s:/-])(?:p2|s2|medium|normal|minor)$|^中$|优先级[:：]?\s*中|次要/ },
  { rank: 30, label: "低", pattern: /(?:^|[\s:/-])(?:p3|s3|low|trivial)$|^低$|优先级[:：]?\s*低|不重要/ },
];

/** @param {string[]} labels @returns {{ rank: number, label: string }} */
export function priorityOf(labels = []) {
  let best = { rank: 50, label: "未设置" };
  for (const raw of labels) {
    const value = String(raw || "").trim().toLowerCase();
    const level = LEVELS.find((item) => item.pattern.test(value));
    if (level && level.rank < best.rank) best = { rank: level.rank, label: level.label };
  }
  return best;
}

/** 定时拉单的门槛：severe 只拉紧急；major 拉紧急和高；all 再加上未设置优先级的（中、低不自动拉）。 */
export const PULL_THRESHOLDS = ["severe", "major", "all"];

/** @param {{ rank: number }} priority @param {string} threshold */
export function matchesThreshold(priority, threshold) {
  if (priority.rank === 0) return true;
  if (priority.rank === 10) return threshold === "major" || threshold === "all";
  if (priority.rank === 50) return threshold === "all";
  return false;
}

/** @param {{ priority: { rank: number }, number: number }} a @param {{ priority: { rank: number }, number: number }} b */
export function byPriority(a, b) {
  return a.priority.rank - b.priority.rank || a.number - b.number;
}
