# Codex-style desktop workspace design

## Goal

Replace the crowded dark dashboard with a light, conversation-centered desktop workspace. Keep task submission, project isolation, saved history, per-agent observation, run controls, exports, archive/restore, and credential settings.

## Layout

- **Project/history sidebar:** compact persistent left rail containing app navigation, project selection, recent task conversations, a new-task action, and settings entry.
- **Conversation workspace:** central white surface with a small project/task header, user requests and structured agent responses in chronological order, visible task status, and a composer anchored at the bottom.
- **Observation inspector:** closed by default. Opening an agent or “View execution” reveals a right-side panel with that agent's structured events, tool/file activity, errors, and pause/resume/terminate controls. Closing it returns the space to conversation.
- **Settings:** move credentials and gateway restart into a dedicated settings view rather than keeping a large form above every task.

At narrow window sizes, collapse the sidebar to an icon rail and present the inspector as an overlay panel. Do not hide task controls or connection state.

## Visual direction

Use a white main surface, restrained light-gray navigation and separators, near-black readable text, and a single muted blue accent for selection and primary actions. Use compact system typography, consistent control shapes, minimal borders, and no decorative cards around every message. Maintain clear focus indicators and reduced-motion support.

## Interaction and data

- Selecting a project filters the existing task/history data and preserves context isolation.
- Selecting a task opens its conversation and task-specific structured timeline.
- Starting a task from the composer creates the existing project-scoped task; subsequent messages should not imply unsupported free-form continuation unless the backend supports it.
- Opening an Agent inspector filters to that agent's structured events; it must never display prompts or hidden chain-of-thought.
- Pause, resume, and terminate remain task-scoped and report success/failure inline.
- Connection failure, empty history, missing project, and unconfigured credentials each get concise actionable states.

## Implementation scope

Reshape the current React renderer and styles without changing task orchestration or its WebSocket protocol. Keep all existing capabilities reachable. Add UI tests or focused component-level checks for navigation, inspector visibility, project/task selection, and connection/error states where the existing setup permits. Verify the packaged Electron app at its target Windows size and a narrow viewport.

## Acceptance criteria

1. The first screen is a light conversation workspace, not a dark dashboard.
2. Projects and recent task history are available in a compact persistent sidebar.
3. The task composer is anchored at the bottom of the central conversation.
4. Agent execution details open on demand in a dedicated inspector and remain limited to structured trace fields.
5. Existing task lifecycle and history actions remain accessible.
6. Settings no longer dominate the task workspace.
7. The package renders in Electron using local assets and has clear empty, disconnected, and unconfigured states.
