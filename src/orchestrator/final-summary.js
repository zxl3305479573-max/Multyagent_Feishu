const pathKey = (value) => String(value || "").replaceAll("\\", "/");
const unique = (values) => [...new Set(values.filter(Boolean))];
const clip = (value, max = 300) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function mergedArtifacts(history) {
  const artifacts = new Map();
  for (const item of history) {
    for (const path of item.artifactPaths || []) {
      if (!path) continue;
      const key = pathKey(path);
      const previous = artifacts.get(key);
      artifacts.set(key, { ...(previous || {}), path, description: previous?.description || "" });
    }
    for (const artifact of item.artifactItems || []) {
      if (!artifact?.path) continue;
      const key = pathKey(artifact.path);
      artifacts.set(key, {
        ...(artifacts.get(key) || { path: artifact.path }),
        ...artifact,
      });
    }
  }
  return [...artifacts.values()];
}

function agentCounts(deliveries) {
  const counts = new Map();
  for (const item of deliveries) {
    const key = item.agentKey || "unknown";
    const entry = counts.get(key) || { key, names: new Set(), count: 0 };
    entry.names.add(String(item.agentName || item.agentKey || "未知机器人"));
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].map((item) => ({ key: item.key, name: [...item.names].join("、"), count: item.count }));
}

/** 汇总子机器人交付；项目经理自己的规划与阶段回复不计入最终统计。 */
export function aggregateChildDeliveries(history = []) {
  const deliveries = history.filter((item) => item?.agentKey && item.agentKey !== "project_manager");
  const artifacts = mergedArtifacts(deliveries);
  const acceptances = deliveries.map((item) => item.acceptance).filter(Boolean);
  const agents = agentCounts(deliveries);
  return {
    deliveries,
    deliveryCount: deliveries.length,
    agents,
    agentCount: agents.length,
    artifactPaths: artifacts.map((item) => item.path),
    artifactItems: artifacts,
    artifactCount: artifacts.length,
    acceptanceCount: acceptances.length,
    acceptancePassed: acceptances.filter((item) => item.verdict === "pass").length,
    acceptanceFailed: acceptances.filter((item) => item.verdict === "fail").length,
    blockers: unique(deliveries.flatMap((item) => item.blockers || [])),
    risks: unique(deliveries.flatMap((item) => item.risks || [])),
  };
}

/** 生成稳定的系统统计，避免最终结论只依赖模型是否主动汇总。 */
export function formatChildDeliverySummary(aggregate) {
  if (!aggregate?.deliveryCount) return "";
  const lines = [
    "执行汇总（系统统计）：",
    `- 子机器人交付：${aggregate.deliveryCount} 项`,
    `- 覆盖角色：${aggregate.agentCount} 个${aggregate.agents.length ? `（${aggregate.agents.map((item) => `${item.name} ${item.count} 项`).join("；")}）` : ""}`,
    `- 交付文件：${aggregate.artifactCount} 个`,
    aggregate.acceptanceCount
      ? `- 结构化验收：${aggregate.acceptanceCount} 项，通过 ${aggregate.acceptancePassed} 项${aggregate.acceptanceFailed ? `，未通过 ${aggregate.acceptanceFailed} 项` : ""}`
      : "- 结构化验收：未记录",
    "- 子任务结论：",
    ...aggregate.deliveries.map((item) => {
      const owner = item.agentName || item.agentKey;
      const assignment = item.assignmentId ? `（${item.assignmentId}）` : "";
      return `  - ${owner}${assignment}：${clip(item.summary || "已完成交付")}`;
    }),
  ];
  if (aggregate.artifactPaths.length) {
    lines.push("- 文件清单：", ...aggregate.artifactPaths.map((path) => `  - ${path}`));
  }
  if (aggregate.blockers.length) lines.push(`- 阻塞：${aggregate.blockers.join("；")}`);
  if (aggregate.risks.length) lines.push(`- 风险：${aggregate.risks.join("；")}`);
  return lines.join("\n");
}

/** 项目经理最终交付时合并全部子任务文件，并把系统统计追加到结论末尾。 */
export function finalizeProjectManagerDelivery(delivery, history = [], { qualitySummary = "", qualityArtifacts = [] } = {}) {
  const aggregate = aggregateChildDeliveries(history);
  if (!aggregate.deliveryCount && !qualitySummary) return { delivery, aggregate };
  const summary = String(delivery.summary || "").trim();
  const statistics = formatChildDeliverySummary(aggregate);
  const artifactItems = mergedArtifacts([
    ...aggregate.deliveries,
    {
      artifactPaths: [...(delivery.artifactPaths || []), ...qualityArtifacts.map((item) => item.path)],
      artifactItems: [...(delivery.artifactItems || []), ...qualityArtifacts],
    },
  ]);
  return {
    delivery: {
      ...delivery,
      summary: summary.includes("质量门禁（系统统计）")
        ? summary
        : [summary || "已完成全部子任务。", statistics, qualitySummary].filter(Boolean).join("\n\n"),
      artifactPaths: artifactItems.map((item) => item.path),
      artifactItems,
    },
    aggregate,
  };
}
