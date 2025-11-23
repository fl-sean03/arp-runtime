# Master Verification Checklist (v0.1 - v0.3)

This document tracks the verification status of the Remote Codex Agent Runtime across all release milestones.

## v0.1: Core Runtime & Lifecycle (Complete)

| ID | Criterion | Status | Notes |
|----|-----------|--------|-------|
| 1 | **Create Project** | [x] Pass | Verified via `verify.sh`. |
| 2 | **Open Project** | [x] Pass | Container started, warm state confirmed. |
| 3 | **Send Prompt** | [x] Pass | File creation verified. |
| 4 | **Response** | [x] Pass | Text + Diff returned. |
| 5 | **Idle Lifecycle** | [x] Pass | Container stops after TTL. |
| 6 | **Persistence** | [x] Pass | Edits persist across restarts. |
| 7 | **Thread Continuity** | [x] Pass | Context persists across restarts. |
| 8 | **LRU Eviction** | [x] Pass | Opening new project evicts old one (per user). |
| 9 | **Thread Resume** | [x] Pass | Context restored after eviction. |
| 10 | **Error Handling** | [x] Pass | Atomic failure on invalid repo. |
| 11 | **Test Execution** | [x] Pass | `run tests` executes and returns output. |
| 12 | **Concurrency Locking** | [x] Pass | Parallel requests serialized. |
| 13 | **Cross-Project Isolation** | [x] Pass | Filesystem isolation verified. |
| 14 | **Structured Logging** | [x] Pass | JSON logs with correlation IDs. |
| 15 | **Metrics Endpoint** | [x] Pass | `/metrics` exposed. |
| 16 | **Command Whitelisting** | [x] Pass | Restricted shell execution. |
| 17 | **Resource Limits** | [x] Pass | CPU/Mem limits enforced. |
| 18 | **DB Invariants** | [x] Pass | LRU state consistency verified. |

---

## v0.2: Multi-Tenancy & Observability (Complete)

| ID | Criterion | Status | Notes |
|----|-----------|--------|-------|
| 1 | **User/API Key Schema** | [x] Pass | Tables created, migration successful. |
| 2 | **API Key Auth** | [x] Pass | `X-API-Key` enforced on private routes. |
| 3 | **Per-User Scoping** | [x] Pass | Projects/Workspaces isolated by `user_id`. |
| 4 | **Per-User LRU** | [x] Pass | "One warm workspace" is per-user, not global. |
| 5 | **Run Model** | [x] Pass | `runs` table tracks every execution. |
| 6 | **Run Retrieval** | [x] Pass | `GET /runs/:id` returns full history. |
| 7 | **Streaming SSE** | [x] Pass | `POST /message/stream` emits ordered events. |
| 8 | **Streaming Persistence** | [x] Pass | Streaming runs are durably recorded in DB. |
| 9 | **Daily Quotas** | [x] Pass | `429` returned when limit exceeded. |
| 10 | **Quota Metrics** | [x] Pass | `arp_quota_exceeded_total` increments. |
| 11 | **v0.2 Logging** | [x] Pass | Logs include `userId`, `runId`, `streaming`. |
| 12 | **v0.2 Metrics** | [x] Pass | Labeled metrics for streaming/status. |

---

## v0.3: Evidence & Retention (Complete)

| ID | Criterion | Status | Notes |
|----|-----------|--------|-------|
| 1 | **Env Snapshot Columns** | [x] Pass | `git_commit`, `image_digest` columns added. |
| 2 | **Env Snapshot Population** | [x] Pass | Metadata captured from Worker/Docker and saved. |
| 3 | **Command Log Files** | [x] Pass | `command_log.jsonl` generated in volume. |
| 4 | **Outputs Manifest** | [x] Pass | `outputs.json` generated with diff stats. |
| 5 | **Evidence Bundles** | [x] Pass | `evidence_bundles` table tracks zip generation. |
| 6 | **Evidence Worker** | [x] Pass | Background job zips artifacts successfully. |
| 7 | **Evidence API** | [x] Pass | `GET /runs/:id/evidence` serves zip bundle. |
| 8 | **Event Schema** | [x] Pass | SSE & Logs use standardized TS interfaces. |
| 9 | **Event Logs** | [x] Pass | `events.jsonl` included in evidence bundle. |
| 10 | **Workspace GC** | [x] Pass | Cold volumes deleted after TTL. |
| 11 | **Evidence GC** | [x] Pass | Old zip bundles deleted after TTL. |
| 12 | **v0.3 Metrics** | [x] Pass | GC operations tracked in Prometheus. |

---

## Verification Execution Summary

*   **Date**: 2025-11-21
*   **Script**: `ci_v0.3.sh`
*   **Scope**: Full Regression (v0.1 -> v0.3)
*   **Result**: **GREEN BUILD** (All tests passed)