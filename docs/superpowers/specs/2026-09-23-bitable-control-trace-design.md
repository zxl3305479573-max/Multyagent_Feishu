# Bitable Task Control Plane And Trace Design

## Goal

Extend the existing project-manager-owned Bitable task board into a human
control plane, and project a structured execution trace into a separate table.
The gateway remains the source of truth; Bitable outages must never block
agent execution.

## Scope

- Keep one task row per root task in the existing task board.
- Add deterministic progress, active-agent/current-action, and one-shot
  `控制指令` fields to the board. The status projector must never write the
  control field, so its normal updates cannot erase a human command.
- Support `暂停`, `继续`, and `终止`. Pause is cooperative: the active Pi turn
  and current tool finish, then the orchestrator holds the delivery before any
  next dispatch. Resume replays that saved delivery. Termination aborts all Pi
  sessions for the root task and permanently blocks later dispatches.
- Project structured task, agent, state, tool, command, file-change, test,
  error, and decision events into a dedicated Trace table. Never record model
  hidden reasoning or full prompts. Redact credentials from commands/errors.
- Keep the local JSONL event log as the durable source for trace replay and
  diagnostics. Trace/control failures are isolated from the gateway.
- Only the project-manager Feishu app may resolve or call Bitable APIs.

## Data Flow

```text
Pi session and orchestrator
  -> structured events -> JSONL event log -> task board projection
                                      \-> trace table projection

Human edits task row's 控制指令
  -> project-manager poller -> persisted task control state
  -> pause/resume checkpoint or Pi session abort
  -> clear command cell after successful application
```

The task board continues to use `FEISHU_BITABLE_TABLE_ID`. A separate
`FEISHU_BITABLE_TRACE_TABLE_ID` selects the trace table. If no trace table is
configured, local tracing continues and Bitable task control remains usable.
Missing fields are created additively only when auto-init is enabled.

## Task Board Fields

Add the following fields without renaming, retyping, or deleting existing
fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `进度` | number | Deterministic percentage from planned/completed dispatches; unknown work is not fabricated |
| `执行角色` | text | Currently active role agents for the root task |
| `控制指令` | single select | One-shot exact command: `暂停`, `继续`, or `终止` |
| `控制结果` | text | Last accepted/rejected command and concise outcome |

Existing `状态`, `阶段`, `当前动作`, and timestamps remain the task summary.

## Trace Fields

Each trace row is keyed by `事件编号` and includes `时间`, `任务编号`,
`子任务编号`, `Agent`, `事件类型`, `状态`, `工具`, `命令`, `文件`, `结果`,
`错误`, and `摘要`. Fields that do not apply are blank. A local event ID and
record mapping make projection idempotent across retry/restart.

## Control Semantics And Failure Handling

- Recognize only the three exact Chinese command values; unknown values are
  reported and left visible for correction.
- Apply the command before clearing the cell. Pause/resume/terminate operations
  are idempotent, so a failed acknowledgement can be retried safely.
- Persist paused continuation deliveries and terminated state. A resumed task
  continues from the saved delivery boundary; a terminated task is not resumed.
- Poll and Bitable writes are serialized. API failures are logged locally and
  retried on the next poll/flush without rejecting gateway event handling.
- Do not fall back to another role bot if the project-manager app is absent.

## Privacy

Trace contains lifecycle metadata and concise tool metadata only. It excludes
prompt text, assistant reasoning, full tool outputs, and file contents. Shell
commands and error strings are credential-redacted before JSONL/Trace emission.

## Verification

Unit tests cover progress/state projection, command parsing and acknowledgement,
pause/resume checkpoint replay, termination/active-session abort, tool-event
sanitization, trace idempotency, and Bitable failure isolation. The complete
`npm test` suite is the final local gate. Live Bitable verification is optional
when the project-manager app has editor permission and both table IDs are
configured.
