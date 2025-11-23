# DevGuide v0.3 — Evidence, Events, and Retention

> This defines **what v0.3 is** and **how to build it**, assuming v0.2 is complete and trusted.
> The focus: **reproducible evidence bundles**, **structured events**, and **workspace/run retention**.

---

## 0) Baseline assumptions (v0.2 is DONE)

You **assume** all of this already works and is stable:

- **Architecture**
  - Orchestrator (Fastify/Node/TS).
  - Workspace manager using Docker (dockerode).
  - Codex worker in workspace containers.
  - Postgres with `users`, `api_keys`, `projects`, `workspaces`, `runs`.
  - Monorepo structure already defined in v0.1.

- **v0.1+ features**
  - Single warm workspace per user at a time (per-user LRU).
  - Warm/cold lifecycle with idle timeout.
  - Concurrency lock (mutex) per workspace.
  - No host mounts, one volume per workspace, CPU/mem limits.
  - Codex worker edits repo and returns `finalText + diff + threadId`.

- **v0.2 features**
  - Multi-tenant:
    - `users`, `api_keys`, `authPlugin`, `X-API-Key` required.
    - Projects and workspaces scoped by `user_id`.
  - Run model:
    - `runs` table.
    - `/projects/:id/message` creates durable `run` record.
    - `GET /projects/:id/runs`, `GET /runs/:id`.
  - Streaming:
    - `POST /projects/:id/message/stream` via SSE.
    - `run-start`, `token` (simulated or real), `diff`, `run-complete`.
  - Quotas:
    - Per-user daily run limit (e.g., 500), 429 when exceeded.
  - Observability:
    - Pino structured logs with `userId`, `runId`, etc.
    - Prometheus `/metrics` with `arp_runs_total`, quota metrics, streaming metrics.

You **do not** re-implement v0.1/v0.2. v0.3 extends behavior.

---

## 1) v0.3 Goals

v0.3 turns the runtime into a **reproducibility-grade control plane**:

1. **Environment & snapshot metadata**
   - For every run, capture:
     - container image digest,
     - git commit hash,
     - key environment metadata.

2. **Evidence bundles**
   - Every run can produce a **portable bundle**:
     - metadata (JSON),
     - git diff or commit info,
     - command log,
     - outputs manifest,
     - structured event log.
   - Exposed via an **Evidence API**.

3. **Structured event schema**
   - Unify streaming events, internal logs, and evidence into a single event model.

4. **Retention & Garbage Collection (GC)**
   - Configurable retention for:
     - cold workspaces/volumes,
     - runs/evidence.
   - Background jobs to clean up based on policy.

All of this is broken into **thrusts** that can be built sequentially.

---

## 2) New concepts (high-level)

v0.3 adds three primary concepts on top of v0.2:

1. **Environment snapshot**:
   - `(image_digest, git_commit, runtime metadata)` pinned per run.

2. **Evidence bundle**:
   - A logical package for a run, able to be exported (e.g., zip or structured directory).
   - Contains everything needed for re-run: metadata, diffs, command log, outputs manifest, event log.

3. **Retention policy**:
   - Config-driven TTLs for:
     - cold workspaces,
     - runs/evidence.
   - Implemented as background GC workers in Orchestrator.

---

## Thrust 1 — Environment & Snapshot Metadata

### 1.1 Deliverable

For every `run`, store enough **environment and snapshot data** to later reconstruct:

> `(code at commit X, in environment image Y, with commands Z) → outputs A`

You will **not** replay yet. v0.3 only captures metadata and wires it into runs and evidence.

### 1.2 Schema changes

Extend `workspaces` table:

- Add:
  - `image_name` (text, nullable) — e.g. `codexrt-workspace:v0.2`
  - `image_digest` (text, nullable) — e.g. `sha256:abc...` from Docker inspect.
  - `runtime_metadata` (jsonb, nullable) — free-form info, e.g. Node version, OS, etc.

Extend `runs` table:

- Add:
  - `git_commit` (text, nullable)
  - `image_name` (text, nullable)
  - `image_digest` (text, nullable)
  - `env_snapshot` (jsonb, nullable) — flattened snapshot of everything relevant at run time.

### 1.3 Workspace manager integration

On workspace create/open (warm):

- When a container is created from `WORKSPACE_IMAGE`:
  - Inspect the container or image using dockerode:
    - `Image` → image name/tag.
    - `RepoDigests` or image details → `image_digest`.
  - Store `image_name` + `image_digest` on the `workspaces` row.

Optionally populate `runtime_metadata`:

- At container creation:
  - Add env like `ARP_IMAGE_NAME`, `ARP_IMAGE_DIGEST`.
- Worker can expose `/metadata` endpoint that returns:
  - Node version, OS, installed tools version.
- Orchestrator can call `/metadata` once and save that into `runtime_metadata`.

### 1.4 Worker integration

For each `/run`:

- Before starting Codex logic:
  - Execute `git rev-parse HEAD` in `/workspace/repo`.
  - If success:
    - Set `git_commit` for this run.
  - If repo is dirty or detached:
    - Still capture commit, but record additional flags in `env_snapshot` (e.g., `dirty: true`).

- Optional: capture runtime info per run:
  - Node version: `process.version`.
  - OS: `process.platform`, `process.arch`.
  - Save this as part of `env_snapshot`.

### 1.5 Orchestrator: run record update

When you create `runs` row (status `running`):

- Immediately copy from `workspace`:
  - `image_name`
  - `image_digest`
  - `runtime_metadata` (or subset) into `env_snapshot`.

When worker finishes and returns `git_commit`:

- Update `runs.git_commit`.

**Invariant**:

- Every `run` should have:
  - `image_name`, `image_digest` (if workspace had them).
  - `git_commit` (if git repo is valid).

### 1.6 Acceptance criteria

- [ ] New columns exist and migrations run cleanly.
- [ ] After a run, the `runs` row has:
  - `git_commit` (valid SHA),
  - `image_name`,
  - `image_digest`.
- [ ] Workspace rows have `image_name` + `image_digest`.
- [ ] If git repo missing or broken, `git_commit` is null and `env_snapshot` has an error flag, not a crash.

### 1.7 Manual test

1. Open project, run `/message` once.
2. Query `runs` table for that run:
   - Confirm `git_commit` matches `git rev-parse HEAD` in container.
   - Confirm `image_digest` matches `docker inspect <IMAGE>`.

---

## Thrust 2 — Command Log & Outputs Manifest

### 2.1 Deliverable

For every run:

- Capture **command log** (shell commands executed by worker) plus outputs.
- Produce an **outputs manifest** describing files produced or modified.

This is stored as **files inside the workspace volume** and referenced from DB.

### 2.2 File layout inside workspace

Define a per-run evidence directory in the workspace volume:

- Root: `/workspace/evidence/`
- Per run: `/workspace/evidence/<runId>/`

Inside that directory:

- `command_log.jsonl` — line-delimited JSON entries.
- `outputs.json` — summary manifest.

Directory will be used for bundling later (Thrust 3).

### 2.3 Command log format

Each line in `command_log.jsonl` is a JSON object:

```json
{
  "ts": "2025-11-21T12:34:56.789Z",
  "type": "command",
  "command": "pytest tests/",
  "cwd": "/workspace/repo",
  "exitCode": 0,
  "stdout": "....",
  "stderr": ""
}
````

Constraints:

* `stdout`/`stderr` can be truncated if huge (e.g., max 8KB per field).
* `ts` is ISO8601 string.

### 2.4 Worker changes

Extend worker to **wrap all shell executions**:

* Commands you already allow (from whitelist: `npm test`, `pytest`, `ls`, `cat`, `git`, etc.).
* Implement a `runCommand(cmd: string, args: string[], options)` helper that:

  * Executes the command via `child_process.spawn` or `exec`.
  * Captures stdout/stderr.
  * Writes a single JSON object for each command to `command_log.jsonl`.

Include at least:

* `ts`
* `command`
* `cwd`
* `exitCode`
* `stdout` (truncated)
* `stderr` (truncated)

### 2.5 Outputs manifest

When a run completes:

* Build an `outputs.json` manifest:

```json
{
  "runId": "<uuid>",
  "createdAt": "2025-11-21T12:34:56.789Z",
  "gitCommit": "<sha>",
  "diffSummary": {
    "filesChanged": 3,
    "insertions": 42,
    "deletions": 7
  },
  "artifacts": [
    {
      "path": "results/output.csv",
      "type": "file",
      "sizeBytes": 12345,
      "checksum": "sha256:..."
    }
  ]
}
```

Implementation:

* After `git diff` is computed:

  * Optionally run `git diff --stat` to derive `filesChanged`, `insertions`, `deletions`.
* For now, keep `artifacts` minimal:

  * Either empty list
  * Or manually add paths that match pattern `results/**` or `artifacts/**`.

Future versions can add more sophisticated detection.

### 2.6 Orchestrator integration

* When marking run as finished:

  * Check that `/workspace/evidence/<runId>/command_log.jsonl` and `outputs.json` exist.
  * If they do:

    * Update `runs.env_snapshot` to include a pointer:

```json
{
  "evidencePath": "/workspace/evidence/<runId>",
  "hasCommandLog": true,
  "hasOutputsManifest": true
}
```

You are **not** copying the files out of the volume yet, just ensuring they exist.

### 2.7 Acceptance criteria

* [ ] Every successful run creates `/workspace/evidence/<runId>/command_log.jsonl` and `outputs.json`.
* [ ] `command_log.jsonl` contains entries for each executed command during the run.
* [ ] `outputs.json` has a reasonable summary.
* [ ] If nothing runs (e.g., Codex only edits files), `command_log.jsonl` still exists, possibly empty.

### 2.8 Manual test

1. Trigger a run that executes tests (`npm test` or `pytest`).
2. Exec into the workspace container and inspect `/workspace/evidence/<runId>/`:

   * Confirm `command_log.jsonl` has at least one entry for the test command.
   * Confirm `outputs.json` exists and has `runId` + `gitCommit`.

---

## Thrust 3 — Evidence Bundles & Evidence API

### 3.1 Deliverable

Introduce **evidence bundles** that can be requested per run:

* Logical bundle of:

  * Run metadata (from DB).
  * Environment snapshot.
  * Command log.
  * Outputs manifest.
  * Optionally, git diff.

Expose via an **Evidence API** and optional zip packaging.

### 3.2 Schema

Add `evidence_bundles` table:

* `id` (UUID, PK)
* `run_id` (UUID, FK → `runs.id`, unique)
* `user_id` (UUID, FK → `users.id`)
* `project_id` (UUID, FK → `projects.id`)
* `workspace_id` (UUID, FK → `workspaces.id`)
* `status` (text enum: `pending|ready|error`)
* `bundle_path` (text, nullable) — path to zip on disk or in object storage.
* `created_at` (timestamptz, default now)
* `updated_at` (timestamptz, default now)
* `error_message` (text, nullable)

### 3.3 Bundle structure (logical)

Bundle content (conceptually):

* `metadata.json` — DB-derived run+workspace+project info.
* `env_snapshot.json` — derived from `runs.env_snapshot` and `workspaces.runtime_metadata`.
* `command_log.jsonl` — copied from workspace evidence dir.
* `outputs.json` — copied from workspace evidence dir.
* `diff.patch` — git diff content (optional).
* Optional: `README.txt` explaining fields.

Directory layout inside the zip:

```
<runId>/
  metadata.json
  env_snapshot.json
  command_log.jsonl
  outputs.json
  diff.patch
```

### 3.4 Evidence generation workflow

When a run finishes (status `succeeded` or `failed`):

* Option A (eager):

  * Immediately create evidence bundle:

    * Create `evidence_bundles` row `status='pending'`.
    * Background worker builds zip by:

      * Reading required data from DB and `/workspace/evidence/<runId>/`.
      * Writing files to a temp location.
      * Zipping into `evidence/<runId>.zip` on host or shared storage.
    * Update row to `status='ready'`, `bundle_path='evidence/<runId>.zip'`.
* Option B (lazy):

  * Only create bundle on `GET /runs/:id/evidence` request.
  * For v0.3, **pick Option A** to keep logic deterministic and testable.

### 3.5 Evidence API endpoints

Add:

1. `GET /runs/:id/evidence`

   * Auth required.
   * Check `run.user_id = request.user.id`.
   * Behavior:

     * If `evidence_bundle` row `status='ready'` and `bundle_path` exists:

       * Stream the zip file response.
       * `Content-Type: application/zip`.
     * If `status='pending'`:

       * Return 202 Accepted + JSON:

         * `{ "status": "pending" }`
     * If `status='error'`:

       * Return 500 + JSON:

         * `{ "status": "error", "message": error_message }`
     * If no row:

       * Optionally trigger creation and return 202; for v0.3 you can **require** that all completed runs have evidence entries and treat missing row as error.

2. `GET /projects/:projectId/runs`

   * Already exists, but you can add a flag per run:

     * `hasEvidence: boolean`.

### 3.6 Evidence generation worker

Implement a simple worker inside Orchestrator (or as a separate process):

* Periodically (e.g., every 30s):

  * Find `evidence_bundles` where `status='pending'`.
  * For each:

    * Try to create zip:

      * Build metadata JSONs.
      * Copy `command_log.jsonl`, `outputs.json`.
      * Write `diff.patch` from `runs.diff`.
      * Zip into `evidence/<runId>.zip`.
    * On success:

      * `status='ready'`, `bundle_path='evidence/<runId>.zip'`.
    * On failure:

      * `status='error'`, `error_message=<reason>`.

You can store zips:

* On the Orchestrator host filesystem under a configured root (e.g. `EVIDENCE_ROOT`).
* Or in a simple local object store path.

### 3.7 Acceptance criteria

* [ ] Every completed run (`succeeded` or `failed`) leads to an `evidence_bundles` row.
* [ ] Evidence bundles reach `status='ready'` via worker.
* [ ] `GET /runs/:id/evidence` returns a zip that contains:

  * `metadata.json`
  * `env_snapshot.json`
  * `command_log.jsonl`
  * `outputs.json`
  * `diff.patch` (if diff exists).
* [ ] Authorization: user cannot fetch evidence for another user’s run.

### 3.8 Manual test

1. Run a job that edits files and runs tests.
2. Wait for worker interval.
3. Call `GET /runs/:runId/evidence` with correct API key:

   * Download zip, unzip locally.
   * Inspect contents.
4. Try fetching evidence for a run belonging to a different user → 404 or 403.

---

## Thrust 4 — Structured Event Schema (Runs & Streaming)

### 4.1 Deliverable

Standardize **events** across:

* Streaming SSE.
* `command_log`.
* Evidence metadata.

So that downstream systems can rely on a consistent schema.

### 4.2 Event types

Define an internal event model:

* `RunStarted`
* `RunToken` (for streaming text)
* `RunCommandStarted`
* `RunCommandFinished`
* `RunDiffReady`
* `RunCompleted`

Base shape:

```ts
type BaseEvent = {
  ts: string;        // ISO timestamp
  runId: string;
  type: string;
};

type RunStarted = BaseEvent & {
  type: "RunStarted";
  userId: string;
  projectId: string;
  workspaceId: string;
  prompt: string;
};

type RunToken = BaseEvent & {
  type: "RunToken";
  sequence: number;
  delta: string;
};

type RunCommandStarted = BaseEvent & {
  type: "RunCommandStarted";
  command: string;
  cwd: string;
};

type RunCommandFinished = BaseEvent & {
  type: "RunCommandFinished";
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RunDiffReady = BaseEvent & {
  type: "RunDiffReady";
  diffSummary: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
};

type RunCompleted = BaseEvent & {
  type: "RunCompleted";
  status: "succeeded" | "failed" | "timeout";
  errorMessage?: string;
};
```

You don’t need TS runtime validation, but you should match these fields in JSON.

### 4.3 Streaming SSE alignment

Update `/projects/:id/message/stream` SSE events to embed these:

* `event: run-start`

  * `data`: `RunStarted`
* `event: token`

  * `data`: `RunToken`
* `event: diff`

  * `data`: `RunDiffReady`
* `event: run-complete`

  * `data`: `RunCompleted`

The **shape** is now the event schema, not ad-hoc JSON.

### 4.4 Evidence: event log

Optionally, write a per-run event log:

* Path: `/workspace/evidence/<runId>/events.jsonl`
* Every time the orchestrator emits one of the event types, also append to `events.jsonl`.

This gives you:

* A timeline of the run.
* A single canonical log of the run’s lifecycle.

### 4.5 Command log alignment

You can either:

* Keep `command_log.jsonl` as-is.
* Or treat it as a subset of `RunCommand*` events.

Minimum requirement for v0.3:

* `RunCommandStarted`/`RunCommandFinished` events should reflect what’s in a command log entry.

### 4.6 Acceptance criteria

* [ ] Streaming SSE JSON matches the defined event schema.
* [ ] `events.jsonl` is created per run with `RunStarted` and `RunCompleted` entries at minimum.
* [ ] Command-related events exist for any shell command executed.
* [ ] Evidence bundle includes `events.jsonl`.

### 4.7 Manual test

1. Run a streaming request.
2. Observe SSE stream:

   * Confirm JSON payloads match event types.
3. After completion:

   * Inspect `/workspace/evidence/<runId>/events.jsonl`.
   * Confirm there is `RunStarted`, `RunDiffReady` (if diff), `RunCompleted`.

---

## Thrust 5 — Retention & Garbage Collection (GC)

### 5.1 Deliverable

Add **configurable retention policies** and background GC jobs that:

* Delete old evidence bundles.
* Delete old cold workspaces and their volumes.
* Retain required DB metadata.

### 5.2 Policy configuration

Add env-config:

* `WORKSPACE_COLD_TTL_DAYS` (e.g., 30)
* `EVIDENCE_TTL_DAYS` (e.g., 180)

Meaning:

* Workspaces that have been **cold** for more than `WORKSPACE_COLD_TTL_DAYS` can be deleted (volume removed).
* Evidence bundles older than `EVIDENCE_TTL_DAYS` can be deleted.

### 5.3 Workspace GC

In Orchestrator:

* Add a scheduled job (e.g., every hour):

Algorithm:

1. Find workspaces:

   * `state = 'cold'`
   * `last_active_at < now - WORKSPACE_COLD_TTL_DAYS`
   * Maybe skip if flagged as `pinned` (optional future extension).
2. For each candidate:

   * Use workspace manager to:

     * Stop container (should already be stopped).
     * Delete Docker volume.
   * Update DB:

     * `state = 'deleted'`
     * `volume_name = null`
     * Maybe `deleted_at = now()` (new column).
3. Log actions via Pino.

### 5.4 Evidence GC

Evidence location:

* If zips are on host filesystem (e.g., `${EVIDENCE_ROOT}/${runId}.zip`), you can remove them via Node fs.

GC job:

1. Find `evidence_bundles` where:

   * `status = 'ready'`
   * `created_at < now - EVIDENCE_TTL_DAYS`.
2. For each:

   * Delete file at `bundle_path` if it exists.
   * Update `status = 'deleted'`.
   * Leave DB row for audit, but mark as deleted.

You **do not** delete `runs` rows in v0.3; keep them for audit. Data minimization can come later.

### 5.5 Metrics

Add metrics:

* `arp_workspace_gc_total` — count of workspaces GC’d.
* `arp_evidence_gc_total` — count of evidence bundles GC’d.

### 5.6 Acceptance criteria

* [ ] Configurable TTL env vars respected.
* [ ] Cold workspaces older than TTL are deleted (volumes removed) by GC job.
* [ ] Evidence zip files older than TTL are deleted and marked as `deleted`.
* [ ] GC runs are logged and metrics are incremented.

### 5.7 Manual test

1. Temporarily set low TTLs in `.env`:

   * `WORKSPACE_COLD_TTL_DAYS=0`
   * `EVIDENCE_TTL_DAYS=0`
2. Create a workspace, run something, ensure it goes cold.
3. Wait for GC job.
4. Confirm:

   * Workspace `state='deleted'`, `volume_name=NULL`.
   * Evidence bundle `status='deleted'` and zip file removed.
5. Reset TTLs to sane values.

---

## Thrust 6 — v0.3 Verification & CI

### 6.1 Deliverable

Extend existing CI to cover v0.3:

* New script `ci_v0.3.sh`.
* Reuse v0.1/v0.2 tests.
* Add v0.3-specific tests (env snapshot, evidence, events, GC).

### 6.2 `ci_v0.3.sh`

Script should:

1. Build and start stack.
2. Run v0.1 + v0.2 verification (existing scripts).
3. Run v0.3 tests:

   * `env_snapshot_test.js`
   * `command_log_test.js`
   * `evidence_bundle_test.js`
   * `event_schema_test.js`
   * `gc_test.js`
4. Fail fast on any error.
5. Clean up containers/volumes.

### 6.3 v0.3 Verification Checklist

Create `DevGuide_v0.3_verification.md` with:

| ID | Criterion                    | Status | Notes                                                            |
| -- | ---------------------------- | ------ | ---------------------------------------------------------------- |
| 1  | **Env Snapshot Columns**     | [ ]    | `runs` + `workspaces` have `git_commit`, `image_digest`, etc.    |
| 2  | **Env Snapshot Population**  | [ ]    | Every run populates `git_commit`, `image_digest` where possible. |
| 3  | **Command Log Files**        | [ ]    | `command_log.jsonl` created per run.                             |
| 4  | **Outputs Manifest**         | [ ]    | `outputs.json` created with `runId`, `gitCommit`, diff summary.  |
| 5  | **Evidence Bundles Table**   | [ ]    | `evidence_bundles` exists, rows created per run.                 |
| 6  | **Evidence Worker**          | [ ]    | Bundles transition `pending → ready`.                            |
| 7  | **Evidence API**             | [ ]    | `GET /runs/:id/evidence` returns correct zip or 202/500.         |
| 8  | **Event Schema (Streaming)** | [ ]    | SSE events match standardized schema.                            |
| 9  | **Event Logs**               | [ ]    | `events.jsonl` per run with `RunStarted`/`RunCompleted`.         |
| 10 | **Workspace GC**             | [ ]    | Cold workspaces older than TTL are deleted.                      |
| 11 | **Evidence GC**              | [ ]    | Evidence zips older than TTL are deleted and marked `deleted`.   |
| 12 | **v0.3 Metrics**             | [ ]    | `arp_workspace_gc_total`, `arp_evidence_gc_total` updated.       |

All must be `[x]` with concrete evidence before you declare v0.3 done.

---

## 9) Recommended Implementation Order

To keep cognitive load low:

1. **Thrust 1** — env snapshot fields (DB + wiring).
2. **Thrust 2** — command log + outputs manifest.
3. **Thrust 3** — evidence bundles + Evidence API.
4. **Thrust 4** — structured event schema + streaming alignment.
5. **Thrust 5** — retention & GC.
6. **Thrust 6** — CI + verification doc.

Each thrust is self-contained; finish one fully (code + tests) before starting the next.
