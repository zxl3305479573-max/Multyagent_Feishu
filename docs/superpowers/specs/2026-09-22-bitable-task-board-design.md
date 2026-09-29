# Feishu Bitable Task Board Design

## Goal

Project task state is maintained by the gateway and projected one way into a
Feishu Bitable table. The table is a dashboard, not a command surface and not
an additional source of truth.

The configured target is a Wiki-hosted Bitable. At startup the gateway resolves
the Wiki node token to its Bitable object token, then uses that token together
with the configured table ID for all API calls.

## Configuration

- `FEISHU_BITABLE_WIKI_TOKEN`: Wiki node token for a Bitable-hosted dashboard.
- `FEISHU_BITABLE_APP_TOKEN`: optional direct Bitable object token. If set, it
  takes precedence over the Wiki token.
- `FEISHU_BITABLE_TABLE_ID`: destination table ID.

The project-manager application is the sole Bitable API caller. Other role
bots never receive Bitable tools or credentials.

If required configuration is absent, the gateway runs normally and logs that
dashboard sync is disabled. If Wiki resolution or a Bitable request fails, it
logs the failure and continues task execution.

## Data Model

One Bitable record represents one root task. A local persistent mapping stores
`task_id -> record_id` so repeated task events update rather than create a new
row. On gateway restart, the mapping is restored; if absent, the sync service
searches Bitable by `task_id` before creating a record.

The required Bitable fields and their types are:

| Field | Type | Source |
| --- | --- | --- |
| `task_id` | text | Root task ID |
| `title` | text | Task title or first user instruction |
| `project_id` | text | Project name |
| `owner_agent` | text | Current role owner |
| `stage` | text | Latest lifecycle event |
| `status` | single select or text | received, in_progress, awaiting_approval, paused, completed, failed |
| `priority` | text | Task priority when available |
| `progress` | number | Optional progress value |
| `depends_on` | text | Dependency IDs |
| `current_action` | text | Latest action |
| `blocker` | text | Joined blockers |
| `risk` | text | Joined risks |
| `input_artifacts` | text | Input artifact paths |
| `output_artifacts` | text | Output artifact paths |
| `attempt` | number | Attempt count |
| `started_at` | date/time or text | Start time |
| `updated_at` | date/time or text | Last event time |
| `completed_at` | date/time or text | Completion time |

Startup reconciles the schema by adding only the fields that are missing. The
reconciliation is additive: it never renames, retypes, or deletes an existing
field, so a table the user has already customised stays intact. Set
`FEISHU_BITABLE_AUTO_INIT=false` to disable creation, in which case missing
fields are reported as a configuration error and the dashboard stays off.

## Sync Flow

1. Gateway creates or updates its local task state.
2. Gateway emits a structured lifecycle event.
3. The Bitable projector derives the root task ID and materializes its latest
   status from structured task state/events.
4. The projector creates or updates the corresponding Bitable record.
5. A sync failure is recorded locally and does not affect card callbacks,
   agents, approvals, or downstream dispatch.

Synchronization occurs for task creation, start, delivery, approval required,
dispatch start/completion/failure, task settlement, hold, and failure.

## Idempotency And Safety

- `task_id` is the unique synchronization key.
- A local record-ID mapping is written atomically after a successful create.
- An update that encounters a stale record ID clears the mapping, searches by
  `task_id`, then retries once.
- The service writes only the configured table and only the documented fields.
- Manual Bitable edits are not consumed by the gateway and may be overwritten
  by the next task event.

## Verification

- Unit tests cover Wiki/direct token configuration, field validation, record
  create/update selection, retry behavior, and failure isolation.
- `scripts/check-bitable.mjs` verifies field read access and an optional write
  probe against the configured table.
- An integration smoke check creates a test task event and verifies one Bitable
  row is created, then a later event updates that same row.
