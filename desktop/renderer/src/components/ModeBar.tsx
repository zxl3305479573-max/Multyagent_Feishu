import React from "react";
import type { Agent, TaskModes } from "../types";
import "./ModeBar.css";

const MODES: Array<{ value: TaskModes["mode"]; label: string; hint: string }> = [
  { value: "ask", label: "问答", hint: "只读回答，不派发、不改文件" },
  { value: "plan", label: "规划", hint: "先出方案，确认后再执行" },
  { value: "auto", label: "自动", hint: "自动完成规划；派发前仍需你确认" },
];

const RUNTIMES: Array<{ value: TaskModes["runtime"]; label: string; hint: string }> = [
  { value: "", label: "默认", hint: "沿用运行设置中的运行模式" },
  { value: "embedded", label: "进程内", hint: "在网关进程内运行，启动快" },
  { value: "rpc", label: "RPC", hint: "每个机器人在独立子进程中运行，超时会被终止" },
];

type Props = {
  value: TaskModes;
  agents: Agent[];
  // 续聊沿用任务原来的协作对象，只能切换执行模式和运行方式。
  lockTarget?: string | null;
  disabled?: boolean;
  onChange: (value: TaskModes) => void;
};

// 输入框下方的模式切换：执行模式 / 协作对象 / 运行方式。
export function ModeBar({ value, agents, lockTarget = null, disabled = false, onChange }: Props) {
  const roles = agents.filter((agent) => agent.enabled !== false && agent.key !== "project_manager");
  const target = lockTarget ?? value.target;
  return <div className="mode-bar" aria-label="任务模式">
    <div className="mode-segment" role="radiogroup" aria-label="执行模式">
      {MODES.map((item) => <button key={item.value} type="button" role="radio" aria-checked={value.mode === item.value} className={value.mode === item.value ? "is-selected" : ""} data-tooltip={item.hint} disabled={disabled} onClick={() => onChange({ ...value, mode: item.value })}>{item.label}</button>)}
    </div>
    <label className="mode-select" data-tooltip={lockTarget ? "续聊沿用任务原来的协作对象" : "团队协作由项目经理组织派发；也可以单独交给一个机器人"}>
      <span>对象</span>
      <select value={target} disabled={disabled || Boolean(lockTarget)} onChange={(event) => onChange({ ...value, target: event.target.value })}>
        <option value="team">团队协作</option>
        {roles.map((agent) => <option key={agent.key} value={agent.key}>单独：{agent.displayName || agent.key}</option>)}
      </select>
    </label>
    <label className="mode-select" data-tooltip={RUNTIMES.find((item) => item.value === value.runtime)?.hint || "选择 Agent 的运行方式"}>
      <span>运行</span>
      <select value={value.runtime} disabled={disabled} onChange={(event) => onChange({ ...value, runtime: event.target.value as TaskModes["runtime"] })}>
        {RUNTIMES.map((item) => <option key={item.value || "default"} value={item.value}>{item.label}</option>)}
      </select>
    </label>
  </div>;
}
