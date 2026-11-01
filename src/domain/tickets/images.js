// @ts-check
// 工单附图：把 issue 正文里的图片下载到项目目录，提示词里给本地路径，Agent 才能真正“看到”截图。
// 只下载 http(s) 图片，单张不超过 10MB、每张工单最多 8 张；令牌只发给 GitHub 自家的附件域名。
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const MARKDOWN_IMG = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMG = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 8;
const AUTH_HOSTS = /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/;
const TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

/** @param {string} body */
export function extractImageUrls(body = "") {
  const urls = new Set();
  for (const pattern of [MARKDOWN_IMG, HTML_IMG]) {
    for (const match of String(body).matchAll(pattern)) {
      const url = match[1]?.trim();
      if (url && /^https?:\/\//i.test(url)) urls.add(url);
    }
  }
  return [...urls].slice(0, MAX_IMAGES);
}

/**
 * @param {{ urls: string[], dir: string, token?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<Array<{ url: string, path?: string, error?: string }>>}
 */
export async function downloadImages({ urls, dir, token = "", fetchImpl = fetch }) {
  const results = [];
  for (const [index, url] of urls.entries()) {
    try {
      const host = new URL(url).hostname;
      const response = await fetchImpl(url, { headers: token && AUTH_HOSTS.test(host) ? { authorization: `Bearer ${token}` } : {}, redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = String(response.headers.get("content-type") || "").split(";")[0].trim();
      if (!type.startsWith("image/")) throw new Error(`不是图片（${type || "未知类型"}）`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_BYTES) throw new Error("超过 10MB");
      const ext = /** @type {Record<string, string>} */ (TYPES)[type] || (extname(new URL(url).pathname).slice(0, 6) || ".img");
      await mkdir(dir, { recursive: true });
      const path = join(dir, `image-${index + 1}${ext}`);
      await writeFile(path, buffer);
      results.push({ url, path });
    } catch (error) {
      results.push({ url, error: /** @type {Error} */ (error).message });
    }
  }
  return results;
}
