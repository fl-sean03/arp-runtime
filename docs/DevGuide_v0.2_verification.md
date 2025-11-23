# v0.2 Verification Checklist

| ID | Criterion | Status | Notes |
|----|-----------|--------|-------|
| 1 | **User & API Key Migrations** | [x] | `users` and `api_keys` exist and migrations succeed. |
| 2 | **API Key Auth** | [x] | `X-API-Key` required, 401 when missing/invalid. Verified via scripts. |
| 3 | **Per-User Project Scoping** | [x] | Users only see their projects, cross-access 404. Verified via isolation tests. |
| 4 | **Per-User Workspace LRU** | [x] | One warm workspace per user, multi-user OK. Verified via advanced verification. |
| 5 | **Run Creation** | [x] | Every message → one `runs` row. Verified via run tests. |
| 6 | **Run Retrieval** | [x] | `GET /runs/:id` returns correct details, scoped by user. |
| 7 | **Streaming SSE** | [x] | `/message/stream` works and sends ordered events. Verified via streaming tests. |
| 8 | **Streaming Run Persistence** | [x] | Streaming runs appear in `runs` with correct status. |
| 9 | **Daily Run Quotas** | [x] | Limit enforced, 429 on exceed, no run created. Verified via quota tests. |
| 10 | **Quota Metrics** | [x] | Metrics increment on quota failures. Verified via observability tests. |
| 11 | **v0.2 Logging** | [x] | Logs include user/run metadata, no secrets. Verified via observability tests. |
| 12 | **v0.2 Metrics** | [x] | Metrics track runs by status and streaming flag. Verified via observability tests. |