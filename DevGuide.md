# DevGuide v0.1 — Remote Codex Agent Runtime (Minimal)

## 0) What you’re building (v0.1 goal)

You’re not building a general platform yet. You’re proving the core loop:

**Frontend → Orchestrator → Workspace → Codex SDK → Repo changes → Back to Frontend**

If this loop works reliably, everything else (multi-tenant, scale, billing, K8s, fancy UI) is just engineering.

### v0.1 must support:

* One user.
* Multiple projects *but only one warm workspace at a time*.
* Docker-based workspaces.
* Repo cloning from Git URL.
* Codex SDK worker running inside the workspace directory.
* Warm/cold lifecycle (idle stop).
* Return:

  * final Codex response text
  * git diff of what changed

### v0.1 does NOT support:

* K8s.
* Parallel workspaces per user.
* True live streaming of agent steps (optional nice-to-have).
* File uploads.
* Git push back to remote automatically.
* ACLs, teams, billing, quotas.
* MCP extensions.
* Background schedulers beyond a tiny idle timer.

---

## 1) High-level architecture (v0.1)

### Components

1. **Orchestrator API (Node/TS)**

   * Owns project records.
   * Creates/stops workspaces.
   * Routes chat prompts to a workspace worker.
   * Returns final response + diff.

2. **Workspace (Docker container)**

   * Has a repo at `/workspace/repo`.
   * Runs a **Codex worker** service.

3. **Codex worker (Node/TS, inside workspace)**

   * Uses `@openai/codex-sdk`.
   * Runs prompts against the repo directory as cwd.
   * Returns summary + diff.

### Sequence

1. `POST /projects` (create record with repo_url)
2. `POST /projects/:id/open`

   * start container
   * clone repo
   * boot worker
3. `POST /projects/:id/message`

   * orchestrator forwards to worker `/run`
   * worker runs Codex SDK
   * worker computes git diff
   * orchestrator returns response + diff
4. idle timeout → orchestrator stops container but keeps volume

---

## 2) Repo layout (monorepo)

```
backend/
  packages/
    orchestrator/
      src/
      test/
    workspace-manager/
      src/
      test/
    codex-worker/
      src/
      test/
    shared/
      src/
  infra/
    docker/
      workspace.Dockerfile
      compose.yml
  .env.example
  README.md
```

---

## 3) Environment / prerequisites

### Developer machine requirements

* Node 20+
* Docker Desktop
* Git
* PNPM (recommended)

### .env for local dev

```
OPENAI_API_KEY=...
POSTGRES_URL=postgres://postgres:postgres@localhost:5432/codexrt
WORKSPACE_IMAGE=codexrt-workspace:v0.1
WARM_IDLE_MINUTES=20
```

---

## 4) Data model (minimal Postgres)

### Table: `projects`

* `id` uuid pk
* `name` text
* `repo_url` text
* `created_at` timestamp

### Table: `workspaces`

* `id` uuid pk
* `project_id` fk
* `state` text enum: `warm|cold|error`
* `container_id` text nullable
* `volume_name` text
* `thread_id` text nullable
* `last_active_at` timestamp
* `idle_expires_at` timestamp

That’s it.

---

## 5) Services and responsibilities

### 5.1 Orchestrator

Must implement:

* create/open/stop project workspaces
* send prompt and return result
* enforce 1 warm workspace per user (LRU-stop previous)

Minimal endpoints:

1. `POST /projects`

```json
{ "name":"myproj", "repoUrl":"https://github.com/user/repo.git" }
```

Return:

```json
{ "projectId":"..." }
```

2. `POST /projects/:id/open`
   Return:

```json
{ "workspaceId":"...", "state":"warm" }
```

3. `POST /projects/:id/message`

```json
{ "text":"Add a function that..." }
```

Return:

```json
{
  "runId":"...",
  "finalText":"...",
  "diff":"<git diff here>"
}
```

4. `POST /projects/:id/stop`
   Return:

```json
{ "state":"cold" }
```

### 5.2 Workspace manager (Docker)

Must implement:

* `createWarmWorkspace(project)`
* `stopWorkspace(workspace)`
* `deleteWorkspace(workspace)` (manual only in v0.1)

### 5.3 Codex worker

Must implement:

* `POST /run`
* uses Codex SDK
* returns:

  * final assistant text
  * threadId
  * git diff

---

## 6) Thrust-by-thrust build plan (v0.1)

### Thrust 1 — Orchestrator skeleton

**Deliverable:** Runs locally, DB connected, endpoints stubbed.

Steps:

1. Bootstrap `packages/orchestrator` with Fastify + TS.
2. Add `shared/db` with a tiny query wrapper (pg or kysely).
3. Implement `POST /projects`.
4. Implement `POST /projects/:id/open` → insert workspace row → call workspace-manager stub.
5. Implement `POST /projects/:id/message` → stub return.

Tests:

* route validation unit tests
* db integration: create project row

Acceptance:

* you can create a project and open it (even if stubbed).

---

### Thrust 2 — Workspace image + manager create/start

**Deliverable:** Can start a container with a persistent volume.

Steps:

1. Write `infra/docker/workspace.Dockerfile`:

   * base `node:20-slim`
   * install git
   * install `@openai/codex` CLI globally (SDK relies on it)
   * copy codex-worker build output

2. Build image in compose.

3. In `workspace-manager`, use dockerode:

   * create volume `ws-<workspaceId>`
   * create container:

     * mount volume → `/workspace/repo`
     * env inject `OPENAI_API_KEY`
     * expose port `7000`
   * start container

4. Return `{containerId, volumeName}`.

Tests:

* integration test: create container, verify running, stop/remove.

Acceptance:

* `open` endpoint yields a running container + volume.

---

### Thrust 3 — Repo clone into volume

**Deliverable:** Workspace ends with repo at `/workspace/repo`.

Steps:

1. After container start, exec inside container:

   * `bash -lc "if [ ! -d .git ]; then git clone <repoUrl> .; fi"`
2. Validate `.git` exists.

Tests:

* open workspace on a small public repo.
* exec `ls` and check expected files.

Acceptance:

* volume contains a valid git checkout.

---

### Thrust 4 — Codex worker service

**Deliverable:** In-container worker can run Codex SDK against repo.

Steps:

1. In `packages/codex-worker`:

   * Fastify server on port 7000
   * endpoint `POST /run`

2. Worker boot:

   ```ts
   import { Codex } from "@openai/codex-sdk";

   const codex = new Codex();
   let thread = null;

   async function getThread(existingId?: string) {
     if (existingId) return codex.resumeThread(existingId);
     return codex.startThread();
   }
   ```

3. `/run` handler:

   * read `text`
   * ensure cwd is `/workspace/repo`
   * before run: `git status --porcelain` should be clean (log if not)
   * `thread = thread ?? await getThread(process.env.CODEX_THREAD_ID)`
   * `const result = await thread.run(text)`
   * after run:

     * `const diff = exec("git diff")`
     * `const threadId = thread.id` (or returned handle)
   * return `{finalText: result.text, diff, threadId}`

Tests:

* unit: mock Codex thread.run.
* integration: prompt “create hello.txt with hi”; verify diff contains file.

Acceptance:

* calling worker directly edits repo and returns diff.

---

### Thrust 5 — Orchestrator ↔ Worker bridge

**Deliverable:** Orchestrator “message” endpoint triggers Codex and returns edits.

Steps:

1. Store worker URL per workspace:

   * in local docker: use container IP from dockerode inspect.
2. In `/projects/:id/message`:

   * load warm workspace for project
   * POST to `http://<ip>:7000/run`
   * update db `thread_id`, `last_active_at`, `idle_expires_at`
   * return worker response to client

Tests:

* end-to-end test with real workspace:

  * open project
  * send prompt
  * confirm response + diff returned

Acceptance:

* browser → orchestrator → codex → diff back works.

---

### Thrust 6 — Warm/cold lifecycle (minimal)

**Deliverable:** Active workspace stays warm; idle becomes cold; reopening resumes.

Steps:

1. On every successful `/message`:

   * set `idle_expires_at = now + WARM_IDLE_MINUTES`
2. Add a tiny interval job in orchestrator:

   * every 60s:

     * find warm workspaces with `idle_expires_at < now`
     * stop container (keep volume)
     * set state=cold, container_id=null
3. On `/projects/:id/open`:

   * if cold:

     * start new container mounting existing volume
     * pass `CODEX_THREAD_ID` env from db
     * set state=warm

Tests:

* warm retention:

  * open → warm
  * send 2 prompts within TTL
  * assert container never stopped
* idle stop:

  * open → warm
  * wait TTL+buffer
  * assert container stopped but volume intact
* cold resume:

  * after idle stop, open again
  * send prompt
  * assert previous edits still present

Acceptance:

* inactive projects cost disk only.

---

## 7) Operational rules for v0.1

1. **Exactly one warm workspace per user.**
   Opening a new project auto-stops the old one.
2. **No parallel Codex runs.**
   If workspace is busy, reject or queue with a single-slot lock.
3. **Never delete volumes automatically.**
   Deletion is manual in v0.1 to avoid data loss.
4. **No git push.**
   You’re proving edits locally; syncing is v0.2+.

---

## 8) Minimal security (still required)

Even v0.1 must do:

* no host mounts
* separate volume per workspace
* workspace has only `OPENAI_API_KEY`
* no other secrets in container
* optional timeout kill per run (e.g., 10 min hard cap)

---

## 9) Definition of “v0.1 done”

You can demonstrate:

1. Create project with repo URL.
2. Open project → container + repo ready.
3. Send prompt:

   * Codex edits files.
   * If prompt asks to run tests, it can run them.
4. Response returns:

   * final assistant text
   * git diff showing changes.
5. Don’t touch project for TTL → container stops.
6. Reopen project later → container restarts with same volume + threadId, edits still there.

If any of these fails, v0.1 isn’t done.

---

## 10) v0.2+ roadmap (don’t build now)

Once v0.1 is stable, next upgrades in order:

**v0.2**

* true WS streaming of stdout + agent steps
* multi-warm per user with limits
* file upload into repo
* push branch to remote on request

**v0.3**

* per-user auth + quotas
* background GC for cold retention deletion
* structured event schema

**v1**

* K8s workspaces
* autoscaling
* MCP tool injection
* team spaces + billing + audit logs


