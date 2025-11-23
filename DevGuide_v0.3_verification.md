# v0.3 Verification Checklist

| ID | Criterion | Status | Notes |
|----|-----------|--------|-------|
| 1 | **Env Snapshot Columns** | [x] | `runs` + `workspaces` have `git_commit`, `image_digest`, etc. |
| 2 | **Env Snapshot Population** | [x] | Every run populates `git_commit`, `image_digest` where possible. |
| 3 | **Command Log Files** | [x] | `command_log.jsonl` created per run. |
| 4 | **Outputs Manifest** | [x] | `outputs.json` created with `runId`, `gitCommit`, diff summary. |
| 5 | **Evidence Bundles Table** | [x] | `evidence_bundles` exists, rows created per run. |
| 6 | **Evidence Worker** | [x] | Bundles transition `pending → ready`. |
| 7 | **Evidence API** | [x] | `GET /runs/:id/evidence` returns correct zip or 202/500. |
| 8 | **Event Schema (Streaming)** | [x] | SSE events match standardized schema. |
| 9 | **Event Logs** | [x] | `events.jsonl` per run with `RunStarted`/`RunCompleted`. |
| 10 | **Workspace GC** | [x] | Cold workspaces older than TTL are deleted. |
| 11 | **Evidence GC** | [x] | Evidence zips older than TTL are deleted and marked `deleted`. |
| 12 | **v0.3 Metrics** | [x] | `arp_workspace_gc_total`, `arp_evidence_gc_total` updated. |