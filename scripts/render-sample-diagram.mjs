// 调试图脚本：用一份示例规格渲染架构流程图到 PNG，方便本地看布局效果。
// 只写文件、不调飞书接口。
//   node scripts/render-sample-diagram.mjs
import { writeFileSync } from "node:fs";
import { renderDiagramPng } from "../src/diagram.js";

const spec = {
  title: "学生信息管理系统 · 系统架构",
  nodes: [
    { id: "admin", label: "管理端浏览器", layer: "接入层" },
    { id: "web", label: "前端 SPA（原生 ES Module）", layer: "接入层" },
    { id: "api", label: "Express 路由层", layer: "服务层" },
    { id: "svc", label: "学生 / 班级 / 成绩服务", layer: "服务层" },
    { id: "auth", label: "会话与鉴权", layer: "服务层" },
    { id: "db", label: "SQLite（better-sqlite3）", layer: "数据层" },
    { id: "files", label: "导入导出文件", layer: "数据层" },
  ],
  edges: [
    { from: "admin", to: "web", label: "HTTPS" },
    { from: "web", to: "api", label: "REST / JSON" },
    { from: "api", to: "svc", label: "调用" },
    { from: "api", to: "auth", label: "校验" },
    { from: "svc", to: "db", label: "SQL" },
    { from: "svc", to: "files", label: "CSV" },
    { from: "auth", to: "db", label: "会话表" },
  ],
};

const out = process.argv[2] || "runtime/artifacts/_tmp/sample-diagram.png";
const png = renderDiagramPng(spec, { width: 1100 });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
