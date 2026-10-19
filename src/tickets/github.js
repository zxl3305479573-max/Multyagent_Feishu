// @ts-check
// GitHub Issues 客户端：只用到工单收件箱需要的几个 REST 接口。
// 令牌只发给 api.github.com；列表里的 Pull Request 会被过滤掉（GitHub 把 PR 也算作 issue）。
import { priorityOf } from "./priority.js";

const API = "https://api.github.com";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** @param {string} repo */
export function assertRepo(repo) {
  const value = String(repo || "").trim();
  // 名称里允许点号，但 "." / ".." 这类纯点段会让请求路径跳出 /repos/。
  if (!REPO.test(value) || value.split("/").some((part) => /^\.+$/.test(part))) throw new Error("仓库须为 owner/name 形式");
  return value;
}

/**
 * @param {any} raw
 * @returns {{ number: number, title: string, body: string, url: string, state: string, labels: string[], assignees: string[], updatedAt: string, priority: { rank: number, label: string } }}
 */
export function toTicket(raw) {
  const labels = (raw?.labels || []).map((/** @type {any} */ label) => typeof label === "string" ? label : label?.name).filter(Boolean);
  return {
    number: Number(raw?.number),
    title: String(raw?.title || ""),
    body: String(raw?.body || ""),
    url: String(raw?.html_url || ""),
    state: String(raw?.state || "open"),
    labels,
    assignees: (raw?.assignees || []).map((/** @type {any} */ user) => user?.login).filter(Boolean),
    updatedAt: String(raw?.updated_at || ""),
    priority: priorityOf(labels),
  };
}

/**
 * @param {{ token?: string, fetchImpl?: typeof fetch }} [options]
 */
export function createGitHubClient({ token = process.env.GITHUB_TOKEN || "", fetchImpl = fetch } = {}) {
  /** @param {string} path @param {{ method?: string, body?: any }} [init] */
  async function request(path, { method = "GET", body } = {}) {
    if (!token) throw new Error("未配置 GITHUB_TOKEN，无法访问 GitHub Issues");
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "multyagent-feishu",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 200);
      try { message = JSON.parse(text).message || message; } catch {}
      throw new Error(`GitHub ${method} ${path.split("?")[0]} 失败（${response.status}）：${message}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    hasToken: () => Boolean(token),
    /** 打开状态的 issue（不含 PR），可按标签、指派人过滤。 @param {string} repo @param {{ labels?: string[], assignee?: string, limit?: number }} [filter] */
    async listOpenIssues(repo, { labels = [], assignee = "", limit = 100 } = {}) {
      const params = new URLSearchParams({ state: "open", per_page: String(Math.min(100, limit)), sort: "updated", direction: "desc" });
      if (labels.length) params.set("labels", labels.join(","));
      if (assignee) params.set("assignee", assignee);
      const list = await request(`/repos/${assertRepo(repo)}/issues?${params}`);
      return (Array.isArray(list) ? list : []).filter((item) => !item.pull_request).map(toTicket);
    },
    /** @param {string} repo @param {number} number */
    async getIssue(repo, number) {
      return toTicket(await request(`/repos/${assertRepo(repo)}/issues/${Number(number)}`));
    },
    /** @param {string} repo @param {number} number @param {string} body */
    async comment(repo, number, body) {
      const result = await request(`/repos/${assertRepo(repo)}/issues/${Number(number)}/comments`, { method: "POST", body: { body } });
      return { url: String(result?.html_url || "") };
    },
    /** @param {string} repo @param {number} number */
    async close(repo, number) {
      await request(`/repos/${assertRepo(repo)}/issues/${Number(number)}`, { method: "PATCH", body: { state: "closed", state_reason: "completed" } });
    },
  };
}
