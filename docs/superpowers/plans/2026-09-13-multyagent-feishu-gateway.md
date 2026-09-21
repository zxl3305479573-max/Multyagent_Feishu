# MultyAgent 飞书网关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run a minimal Node.js gateway that connects each configured MultyAgent role to its own Feishu app bot over long connection, routes `@` messages to the matching role handler, and replies using that same bot identity.

**Architecture:** A single process loads role configuration and starts one official Feishu WebSocket client per configured app. Each incoming message is normalized, deduplicated in memory, routed by the receiving app ID, passed to a role handler, and sent back through that role's Feishu API client. Missing credentials are skipped so the first project-manager bot can run before the remaining bots are created.

**Tech Stack:** Node.js 22, `@larksuiteoapi/node-sdk`, `dotenv`, Node built-in test runner.

---

### Task 1: Create the Node project and safe configuration template

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `config/agents.json`
- Create: `.gitignore`

- [ ] **Step 1: Define runtime dependencies and scripts.**

Add an npm start script (`node src/index.js`) and a built-in test script (`node --test`). Depend only on the official Feishu SDK and dotenv.

- [ ] **Step 2: Define role configuration.**

Store role IDs, display names, enabled flags, and environment variable names in `config/agents.json`. Include all eight planned roles, with project manager enabled and the other roles disabled until credentials are supplied.

- [ ] **Step 3: Add secret-safe environment template and ignores.**

Document App ID/App Secret variables for every role plus optional allowed chat ID. Ignore `.env`, logs, and dependency output.

### Task 2: Implement gateway routing and Feishu long connections

**Files:**
- Create: `src/index.js`
- Create: `src/gateway.js`
- Create: `src/handlers.js`

- [ ] **Step 1: Implement pure message normalization and deduplication.**

Parse the Feishu event content JSON, remove the bot mention markup when present, preserve task metadata, and ignore a repeated `message_id`.

- [ ] **Step 2: Implement role handlers.**

Expose `runAgent(agent, text, context)` and return a deterministic acknowledgement containing the role name and task ID. This is the integration boundary for the real MultyAgent execution layer.

- [ ] **Step 3: Implement one Feishu client and WS client per role.**

For each enabled role with both credentials present, create the official SDK API client and WebSocket client, register `im.message.receive_v1`, route the event to the role handler, and send a text reply using `receive_id_type=chat_id`. Log missing credentials and continue.

- [ ] **Step 4: Add input and output error handling.**

Return an immediate acknowledgement before handler execution, catch handler and send failures, and log `task_id`, `agent_key`, `chat_id`, `message_id`, status, and elapsed time without logging secrets or tokens.

### Task 3: Add verification and operator documentation

**Files:**
- Create: `test/gateway.test.js`
- Create: `README.md`

- [ ] **Step 1: Test normalization and deduplication.**

Use the Node built-in test runner to verify mention removal, malformed content handling, and duplicate message suppression.

- [ ] **Step 2: Document setup and run commands.**

Explain copying `.env.example` to `.env`, filling only local credentials, installing dependencies, starting the gateway, and testing with `@MultyAgent-项目经理 测试连接`.

- [ ] **Step 3: Run tests and a configuration smoke check.**

Run `npm test`, then start the gateway without credentials and verify it exits with a clear configuration message or skips unconfigured roles without exposing secrets.
