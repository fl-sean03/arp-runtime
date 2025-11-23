# DevGuide v0.2 — Remote Codex Agent Runtime (Multi-Tenant + Streaming + Quotas)

> This document defines **what v0.2 is** and **how to build it**, assuming v0.1+ is complete and correct.
---

## 0. Baseline Assumptions (v0.1+)

You **must assume v0.1+ is correct and trusted**. Do **not** re-implement v0.1. You are extending it.

We assume all of this already exists and is working:

- **Core components**
  - `Orchestrator` (Fastify/Node) with:
    - Project and workspace APIs.
    - Docker orchestration via `dockerode`.
    - Warm/Cold lifecycle.
    - One warm workspace per user (v0.1 was “one warm per system”; v0.2 will change this per user).
    - Concurrency lock per workspace (in-memory mutex).
    - Structured logging via `pino`.
    - `/metrics` endpoint exposing Prometheus metrics.
  - `Workspace Manager` embedded or as part of Orchestrator (whatever v0.1 used).
  - `Codex Worker` container:
    - Uses `@openai/codex-sdk`.
    - Accepts env vars including `OPENAI_API_KEY` and `CODEX_THREAD_ID`.
    - Can modify repo and calculate git diff.
    - Can run tests via a **whitelisted** set of commands (`npm test`, `pytest`, `ls`, `cat`, `git`, etc.).
  - `Postgres` database with at least:
    - `projects` table.
    - `workspaces` table.
    - `thread_id` persisted on workspace.
    - Timestamps and state fields for warm/cold tracking.

- **Runtime properties**
  - **Workspace lifecycle**
    - `warm` = active container attached to a workspace, volume mounted.
    - `cold` = container stopped, volume intact.
  - **One-warm-workspace rule**: for v0.1+ it’s already implemented (global or per user).
  - **Thread continuity**: `thread_id` persisted and reused on cold → warm.
  - **Security**
    - No host mounts.
    - One Docker volume per workspace.
    - Command whitelisting in worker.
    - CPU/mem limits per workspace container (e.g. 0.5 CPU, 512 MB).
  - **Tests**
    - `verify.sh`, `verify_advanced.sh`, `verify_real_codex.sh`, and `ci_test.sh` all pass.

**You DO NOT touch**:
- The basic warm/cold logic.
- The Codex Worker’s core “edit repo + diff” behavior.
- The Docker security profile (host mounts, sensitive envs, etc.).

You are **only extending** functionality for v0.2.

---

## 1. v0.2 Goals

v0.2 upgrades the platform from “single-user prototype” to a **multi-tenant, observable runtime** with:

1. **Multi-tenancy**:
   - First-class `users`.
   - Auth via API keys.
   - Projects and workspaces scoped per user.
   - One-warm-workspace **per user**, not global.

2. **Run / Evidence Model**:
   - Each `/message` call becomes a durable **Run** record.
   - Rich metadata stored for audit, debugging, and evidence bundles.

3. **Streaming Responses**:
   - Real-time token/line streaming from Codex Worker back to the caller.
   - HTTP SSE (Server-Sent Events) for clients.

4. **Quotas & Limits**:
   - Per-user run quotas and basic rate limiting.
   - Simple but enforceable limits to avoid abuse.

5. **Improved Observability for v0.2 features**:
   - Metrics and logs aware of users and runs.

Everything is decomposed into **Thrusts**. Each thrust:

- Has a **clear deliverable**.
- Is **incremental** and buildable in isolation.
- Comes with **acceptance criteria** and **manual test steps**.

---

## 2. New Data Model (High-Level)

v0.2 adds three core concepts:

1. `users` (tenant identity)
2. `api_keys` (auth)
3. `runs` (durable records for each `/message`)

Optionally, `quotas` or per-user config table.

The rest of the doc will specify exactly how and when to add them.

---

## Thrust 1 — Multi-Tenant Identity & API Key Auth

### 1.1 Deliverable

Introduce a minimal **user model** and **API key authentication** layer so that:

- Every request to Orchestrator is tied to a `user_id`.
- Existing APIs work the same but now scoped per user.
- There is a straightforward way to create users and issue API keys.

### 1.2 Schema Changes

Create:

1. `users` table:
   - `id` (UUID, PK)
   - `email` (text, unique, nullable if you don’t care yet)
   - `name` (text, nullable)
   - `created_at` (timestamp with time zone, default now)
   - `updated_at` (timestamp with time zone, default now)
   - Optional: `is_admin` (boolean, default false)

2. `api_keys` table:
   - `id` (UUID, PK)
   - `user_id` (UUID, FK → `users.id`)
   - `token_hash` (text, not null)
     - Store **hash**, not raw token. Use something like SHA-256.
   - `label` (text, optional; ex: “dev key #1”)
   - `created_at` (timestamptz, default now)
   - `revoked_at` (timestamptz, nullable)

Add migration files to your existing migration system.

### 1.3 Auth Mechanism

- **Header**: `X-API-Key: <raw-token-here>`.
- On each request:
  1. Extract raw token from header.
  2. Hash it using the same scheme as stored `token_hash`.
  3. Look up `api_keys` where:
     - `token_hash = <hash>`
     - `revoked_at IS NULL`
  4. If found → `user_id = api_keys.user_id`.
  5. If not found → 401 Unauthorized.

**Do not** log raw tokens. Only log truncated tokens (e.g. first 6 chars) or hash.

### 1.4 Orchestrator Integration

- Add **Fastify plugin** `authPlugin`:
  - Runs on every route that needs auth.
  - Attaches `request.user = { id, is_admin }` to the request object.
- Add a simple **public route** (no auth):
  - `GET /healthz` returning `{ ok: true }`.
- All other v0.1 routes should now require auth:
  - Projects, workspaces, messaging, metrics if you want to restrict.

### 1.5 Developer Utilities

- Add a **Node CLI script**:
  - `node scripts/create-user-and-key.js --email test@example.com --name "Test User"`
  - Output:
    - `user_id`
    - `api_key` (raw token – show only once)

The script should:
1. Insert into `users`.
2. Generate a random token string (e.g. 32–40 chars).
3. Hash it and insert into `api_keys`.
4. Print the raw token and user info.

### 1.6 Acceptance Criteria

- [ ] `users` and `api_keys` tables exist and migrations run cleanly.
- [ ] `create-user-and-key.js` script works, prints raw token once.
- [ ] `X-API-Key` header required for all non-public routes; invalid/missing returns 401.
- [ ] `request.user.id` is available in all handlers.

### 1.7 Manual Test

1. Run migrations.
2. Run `node scripts/create-user-and-key.js ...`, copy the token.
3. `curl -H "X-API-Key: <token>" http://localhost:PORT/projects` → should work (or 200/empty).
4. `curl http://localhost:PORT/projects` → should give 401.
5. Try an invalid token → 401.

---

## Thrust 2 — Per-User Project & Workspace Isolation

### 2.1 Deliverable

Tie **projects and workspaces** to specific users. Enforce:

- Users only see their own projects.
- LRU and workspace management are **per user**.
- Cross-user isolation is guaranteed by the DB and API.

### 2.2 Schema Changes

Modify `projects` and `workspaces`:

1. `projects` table:
   - Add `user_id` (UUID, FK → `users.id`, NOT NULL).
   - Backfill existing records:
     - Create a special “system” user (e.g. `root@system.local`).
     - Set all existing `projects.user_id` to that `root` user.

2. `workspaces` table:
   - Add `user_id` (UUID, FK → `users.id`, NOT NULL).
   - Backfill similarly for existing rows.

Update indexes:

- `CREATE INDEX idx_projects_user_id ON projects(user_id);`
- `CREATE INDEX idx_workspaces_user_id ON workspaces(user_id);`

### 2.3 Orchestrator Changes

**Project routes**:

- `POST /projects`:
  - Must read `request.user.id` and store it as `user_id` on new project.
- `GET /projects`:
  - Only return rows where `projects.user_id = request.user.id`.
- `GET /projects/:id`:
  - Ensure `project.user_id = request.user.id`, else 404.

**Workspace logic**:

- When opening a project:
  - Find or create workspace with `user_id = request.user.id AND project_id = :id`.
  - LRU eviction must now act on:
    - all **warm** workspaces with `user_id = request.user.id`
    - NOT global system-wide.

### 2.4 DB Invariants

- For a given `user_id`, there must be **at most one warm workspace**.
- A `workspace` must always have `user_id` equal to its associated project’s `user_id`.

You can enforce the second via a constraint or rely on application logic (for now: logic is fine, but write tests).

### 2.5 Acceptance Criteria

- [ ] All project/workspace queries are filtered by `request.user.id`.
- [ ] LRU rule: per user, at most one warm workspace.
- [ ] Cross-user access to projects returns 404, not a different user’s project.

### 2.6 Manual Test

1. Create two users (`UserA`, `UserB`) with their own API keys.
2. Using `UserA`:
   - Create `ProjectA1`.
   - Open it → `WorkspaceA1` becomes warm.
3. Using `UserB`:
   - Create `ProjectB1`.
   - Open it → `WorkspaceB1` becomes warm.
4. Assert:
   - Both `WorkspaceA1` and `WorkspaceB1` are warm simultaneously.
   - `UserB` cannot `GET /projects/:id` for `ProjectA1` (should be 404).
   - LRU eviction for `UserA` opening another project does **not** affect `UserB`.

---

## Thrust 3 — Run Model & Evidence Storage

### 3.1 Deliverable

Introduce a durable **Run** record for every `/projects/:id/message` call.

A Run should capture:

- Inputs: prompt, project/workspace id, user id.
- Outputs: final text, git diff, test output.
- Status: success / error / timeout.
- Timing: start/end, duration.
- Simple metrics: token counts (if available), error reason.

### 3.2 Schema

Create `runs` table:

- `id` (UUID, PK)
- `user_id` (UUID, FK → `users.id`)
- `project_id` (UUID, FK → `projects.id`)
- `workspace_id` (UUID, FK → `workspaces.id`)
- `status` (text, enum in code: `queued`, `running`, `succeeded`, `failed`, `timeout`)
- `prompt` (text) — raw user message string
- `final_text` (text, nullable until run finishes)
- `diff` (text, nullable)
- `test_output` (text, nullable)
- `error_message` (text, nullable)
- `started_at` (timestamptz, default now)
- `finished_at` (timestamptz, nullable)
- `duration_ms` (integer, nullable)
- Optional metrics:
  - `input_tokens` (integer, nullable)
  - `output_tokens` (integer, nullable)

Index on `(project_id, started_at DESC)` and `(user_id, started_at DESC)`.

### 3.3 Orchestrator Flow

For non-streaming `/message`:

1. On receiving a `/projects/:id/message` request:
   - Find project and workspace as before (user-scoped).
   - Create a `run` row with:
     - `status = 'running'`
     - `started_at = now()`
     - `user_id = request.user.id`
     - `project_id`, `workspace_id`
     - `prompt` = body.prompt
   - Pass `run_id` to the worker as env or argument (e.g. `RUN_ID`).

2. When worker finishes:
   - Capture:
     - `finalText`
     - `diff`
     - `testOutput` (if any)
     - `status` (success or type of failure)
   - Orchestrator updates `runs`:
     - `final_text`, `diff`, `test_output`, `status`, `error_message`, `finished_at`, `duration_ms`.

3. On error/timeout:
   - Update `status = 'failed'` or `'timeout'`.
   - Fill `error_message`.
   - Still set `finished_at` and `duration_ms`.

4. Response to the client remains:
   - `runId`, `finalText`, `diff`, `testOutput`, `status`.

### 3.4 New APIs

Add:

- `GET /projects/:projectId/runs`
  - Auth required.
  - Validate that `project.user_id = request.user.id`.
  - Return a paginated list of `runs` (excluding large fields or truncating `diff`/`final_text`).

- `GET /runs/:id`
  - Validate `run.user_id = request.user.id`.
  - Return full run record, including `final_text`, `diff`, `test_output`, `error_message`.

### 3.5 Acceptance Criteria

- [ ] Every call to `/projects/:id/message` creates exactly one `runs` row.
- [ ] Run status and timestamps are accurate.
- [ ] `GET /runs/:id` returns the correct data and is user-scoped.
- [ ] The existing message flow is unchanged from the client perspective except the presence of `runId`.

### 3.6 Manual Test

1. Call `/projects/:id/message` with a valid prompt.
2. Confirm response includes `runId`.
3. `GET /runs/:runId` returns matching prompt and outputs.
4. Cause a deliberate error (invalid command, forced Codex failure).
5. Confirm `status = 'failed'` or `'timeout'` and `error_message` populated.

---

## Thrust 4 — Streaming Responses (SSE)

### 4.1 Deliverable

Add **streaming** endpoint so clients can receive partial output in real time while still recording a final run.

We will use:

- **SSE (Server-Sent Events)**: `Content-Type: text/event-stream`.

### 4.2 API Design

New endpoint:

- `POST /projects/:id/message/stream`
  - Auth required.
  - Body: `{ "prompt": string, "options": { ...optional flags } }`
  - Response: SSE stream.

SSE events:

- `event: run-start`
  - data: `{ "runId": "<uuid>" }`
- `event: token`
  - data: `{ "delta": "partial text", "sequence": <int> }`
- `event: diff`
  - data: `{ "diff": "git diff content" }`
- `event: test-output`
  - data: `{ "output": "..." }` (optional)
- `event: run-complete`
  - data: `{ "status": "succeeded"|"failed"|"timeout", "errorMessage": null|"..." }`

Terminate the stream after `run-complete`.

### 4.3 Implementation Outline

1. **Orchestrator handler**:
   - Same initial steps as non-stream:
     - Auth.
     - Resolve project/workspace.
     - Create `runs` row (status = `running`).
   - Set response headers:
     - `Content-Type: text/event-stream`
     - `Cache-Control: no-cache`
     - `Connection: keep-alive`
   - Write `run-start` event immediately.
   - Acquire workspace lock (mutex).
   - Start worker in a mode that supports streaming (see below).
   - For each partial chunk from worker:
     - Write `token` events.
   - When worker finishes:
     - Write `diff` and `test-output` events (if any).
     - Update `runs` record.
     - Write `run-complete` event.
   - Release mutex and end stream.

2. **Worker streaming mode**:
   - If full streaming from Codex is available:
     - Use SDK streaming and flush tokens/chunks back to Orchestrator.
   - If you cannot integrate streaming right now:
     - Simulated streaming:
       - Worker returns `finalText` and Orchestrator splits it into artificial `token` or `line` events.
       - This is acceptable as a first step; real streaming can be v0.2.1.

**Important**: even with streaming, you still **persist a `runs` record** exactly as in Thrust 3.

### 4.4 Backward Compatibility

- The existing `/projects/:id/message` endpoint should remain non-streaming for simple clients.
- Streaming is opt-in via `/message/stream`.

### 4.5 Acceptance Criteria

- [ ] Streaming endpoint returns valid SSE events.
- [ ] `run-start` event always comes first and includes a real `runId`.
- [ ] `run-complete` event always comes last.
- [ ] The `runs` table is updated correctly even for streaming runs.
- [ ] Workspace lock still guarantees only one active run per workspace (streaming requests are serialized).

### 4.6 Manual Test

1. Use `curl` or `npx wscat` equivalent or a simple Node client that reads SSE.
2. Connect to `/projects/:id/message/stream`.
3. Send simple prompt.
4. Observe:
   - `run-start` → some `token` events → `diff` → `run-complete`.
5. Check `runs` table for the `runId`.

---

## Thrust 5 — Quotas & Limits

### 5.1 Deliverable

Implement basic **quotas** and **rate limiting** per user to prevent abuse.

Scope:

- Simple per-user caps, not sophisticated global rate limiting.

### 5.2 Policy (v0.2)

We’ll implement:

- **Daily run limit** per user: default `MAX_RUNS_PER_DAY = 500` (configurable).
- **Max concurrent runs** per user: since you already serialize per workspace, this is effectively enforced at 1, but you can still track it.

Later we can add token-level limits; for now, we focus on run counts.

### 5.3 Implementation Strategy

Add a small helper that:

- Reads from `runs` table:
  - `COUNT(*) WHERE user_id = ? AND started_at >= today_start AND started_at < tomorrow_start`.
- Compare with `MAX_RUNS_PER_DAY`.
- If exceeded:
  - Do not start a new run.
  - Return `429 Too Many Requests` with JSON:
    - `{ "error": "quota_exceeded", "message": "Daily run limit reached" }`.

Integrate this check:

- Before:
  - Creating a new `runs` row.
  - Starting any worker execution.
- In both non-stream and streaming endpoints.

**Config**:

- Config file/env:
  - `RUNS_PER_DAY_LIMIT_DEFAULT=500`.

### 5.4 Metrics

Extend `/metrics` with:

- `arp_runs_total{user="<id>"}` (optional label, but watch cardinality; maybe hash/truncate ids).
- `arp_quota_exceeded_total{user="<id>"}`.

If you don’t want user IDs as labels, at least track global counters.

### 5.5 Acceptance Criteria

- [ ] Configurable daily run limit per user.
- [ ] Quota check applied to `/message` and `/message/stream`.
- [ ] On quota exceeded, a new run is NOT created and `429` is returned.
- [ ] Metrics for quota violations increment correctly.

### 5.6 Manual Test

1. Set `MAX_RUNS_PER_DAY` to a low number (e.g., `2`) in config.
2. Run `/message` twice with the same user → both should succeed.
3. Third attempt → should get `429 Too Many Requests`, no run record created.
4. Check `/metrics` for increment.

---

## Thrust 6 — Observability & Logging for v0.2 Features

### 6.1 Deliverable

Extend logging and metrics to support v0.2 features:

- Identify users and runs in logs.
- Track streaming and quotas.

### 6.2 Logging

Enhance existing `pino` logs:

- For every run:
  - Log:
    - `userId`
    - `projectId`
    - `workspaceId`
    - `runId`
    - `status`
    - `durationMs`
    - `streaming` (boolean)

Ensure **no sensitive data** (API keys, full diffs) is logged.

### 6.3 Metrics

Extend Prometheus metrics:

- `arp_runs_total` with labels:
  - `status` (`succeeded`, `failed`, `timeout`)
  - optionally `streaming` (`true`/`false`).
- `arp_streaming_runs_total`
- `arp_quota_exceeded_total`

Update `/metrics` route to expose these gauges/counters.

### 6.4 Acceptance Criteria

- [ ] Every run produces at least one structured log with run metadata.
- [ ] Metrics show correct counts for successful runs, failed runs, streaming runs, and quota violations.
- [ ] No raw API keys or secrets appear in logs.

### 6.5 Manual Test

1. Run a non-streaming run and a streaming run.
2. Check logs:
   - Confirm relevant fields present.
3. `curl /metrics`:
   - Confirm counters increased as expected.

---

## 7. v0.2 Final Verification Checklist

Create a `DevGuide_v0.2_verification.md` with at least:

| ID | Criterion | Status | Notes |
|----|-----------|--------|-------|
| 1 | **User & API Key Migrations** | [ ] | `users` and `api_keys` exist and migrations succeed. |
| 2 | **API Key Auth** | [ ] | `X-API-Key` required, 401 when missing/invalid. |
| 3 | **Per-User Project Scoping** | [ ] | Users only see their projects, cross-access 404. |
| 4 | **Per-User Workspace LRU** | [ ] | One warm workspace per user, multi-user OK. |
| 5 | **Run Creation** | [ ] | Every message → one `runs` row. |
| 6 | **Run Retrieval** | [ ] | `GET /runs/:id` returns correct details, scoped by user. |
| 7 | **Streaming SSE** | [ ] | `/message/stream` works and sends ordered events. |
| 8 | **Streaming Run Persistence** | [ ] | Streaming runs appear in `runs` with correct status. |
| 9 | **Daily Run Quotas** | [ ] | Limit enforced, 429 on exceed, no run created. |
| 10 | **Quota Metrics** | [ ] | Metrics increment on quota failures. |
| 11 | **v0.2 Logging** | [ ] | Logs include user/run metadata, no secrets. |
| 12 | **v0.2 Metrics** | [ ] | Metrics track runs by status and streaming flag. |

Once all are `[x] Pass` with actual log/DB evidence, v0.2 is done.

---

## 8. Implementation Order (Recommended)

To avoid thrashing your mental stack:

1. **Thrust 1** — Users + API keys (auth).
2. **Thrust 2** — Per-user project/workspace scoping.
3. **Thrust 3** — Run model (non-stream).
4. **Thrust 4** — Streaming SSE (reusing Run model).
5. **Thrust 5** — Quotas (using Run model and per-user data).
6. **Thrust 6** — Logging + metrics enrichment.
7. **Verification checklist** — Write + execute.

Each thrust is self-contained and can be implemented in 1–2 focused sessions without reloading the entire system in your head.

