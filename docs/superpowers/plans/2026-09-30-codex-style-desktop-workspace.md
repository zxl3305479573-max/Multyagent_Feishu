# Codex-style desktop workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded dark dashboard with a light conversation-centered Electron workspace while preserving project history, task control, Agent observation, and settings.

**Architecture:** Keep the existing React/Vite renderer and WebSocket contract. Restructure `App` into a navigation sidebar, central task conversation/composer, and an on-demand observation/settings inspector; derive visible content from existing task and structured event data only. Use semantic CSS layout and native controls, with no new runtime dependencies.

**Tech Stack:** Electron 38, React 19, TypeScript, Vite 7, CSS, Node test runner.

---

### Task 1: Extract visible task conversation data

**Files:**
- Modify: `desktop/renderer/src/main.tsx`

- [ ] Add selectors that group structured events by root task and sort them oldest-first for conversation display.
- [ ] Render user submission and agent structured updates as distinct conversation entries; never render prompt or hidden reasoning fields.
- [ ] Keep existing task lifecycle status derivation and selected Agent filtering.

### Task 2: Build the three-region workspace

**Files:**
- Modify: `desktop/renderer/src/main.tsx`
- Modify: `desktop/renderer/src/style.css`

- [ ] Replace the dashboard header/forms/timeline composition with a compact project/history sidebar, central conversation, and bottom-pinned composer.
- [ ] Add a collapsible task inspector showing selected task/Agent structured events and pause/resume/terminate actions.
- [ ] Add a settings view in the inspector for existing credential selection, secure save, configured-key state, and gateway restart.
- [ ] Preserve project export, archive, and restore behind a conversation header menu/controls with inline status feedback.
- [ ] Add responsive behavior that reduces sidebar width and makes the inspector a drawer at compact window widths.

### Task 3: Establish the light visual system and UI states

**Files:**
- Modify: `desktop/renderer/src/style.css`
- Modify: `desktop/renderer/src/main.tsx`

- [ ] Replace the dark theme with white content, restrained neutral navigation, high-contrast text, and one blue action/selection accent.
- [ ] Add visible keyboard focus, disabled/hover states, and reduced-motion support.
- [ ] Make disconnected, browser preview, no-project, no-history, and missing-credentials states actionable and non-blocking.
- [ ] Verify all composer/settings labels remain readable at the current Electron minimum size and a narrow viewport.

### Task 4: Build, test, package, and install

**Files:**
- Verify: `desktop/renderer/src/main.tsx`
- Verify: `desktop/renderer/src/style.css`
- Verify: `dist/desktop/index.html`
- Verify: `release/MultyAgent Agent 工作台-0.1.0-x64.exe`

- [ ] Run `npx tsc -p desktop/tsconfig.json --noEmit` and `npm test`.
- [ ] Run `npm run desktop:build` and verify the built HTML references relative `./assets/` paths.
- [ ] Run `npm run desktop:package` and verify renderer files are present in `release/win-unpacked/resources/app/dist/desktop`.
- [ ] Install to `D:\33054\MultyAgent Agent 工作台` and launch the packaged app to verify the light conversation workspace renders and connects or presents the credential setup state.

---

## Self-review

- Sidebar/project/history requirement: Task 2.
- Conversation and anchored composer: Tasks 1–2.
- On-demand Agent inspector and task controls: Task 2.
- Settings moved out of primary workspace: Task 2.
- Light palette, accessibility, responsive layout, actionable states: Task 3.
- Packaged Windows verification: Task 4.
- No hidden reasoning exposure: Tasks 1 and 2.
