# Verification & Debugging Best Practices

This document captures lessons learned during the implementation of the metadata verification flow (Thrust 1). It serves as a reference for avoiding common pitfalls when writing verification scripts involving Docker, Database, and Orchestrator processes.

## Common Issues & Solutions

### 1. "Stalling" Verification Scripts
**Symptoms**:
- The script hangs indefinitely at a specific step (e.g., "Opening workspace...").
- `Ctrl+C` is required to exit.
- Subsequent runs fail with `ECONNREFUSED` or `EADDRINUSE` (port 3000).

**Root Causes**:
- **Zombie Processes**: Spawning `npm run dev` creates a process tree (`npm` -> `sh` -> `ts-node-dev` -> `node`). Calling `.kill()` on the parent process often leaves the children running, holding the port open.
- **Docker Locks**: If `docker` commands hang (e.g., `git clone` inside a container prompting for auth, or network timeouts), the Orchestrator waits indefinitely, and so does the test script.
- **Missing Timeouts**: `fetch` in Node.js (v18+) does not have a default timeout. If the server drops the request or hangs, `await fetch(...)` will wait forever.

**Solutions**:
- **Aggressive Cleanup**: Use `pkill -f` or `fuser -k port/tcp` to ensure the environment is clean before starting.
  ```bash
  # Example from scripts/cleanup.sh
  pkill -f "ts-node-dev" || true
  fuser -k 3000/tcp || true
  docker ps -q --filter "ancestor=codexrt-workspace:v0.1" | xargs -r docker rm -f
  ```
- **Process Group Killing**: When spawning background processes in Node.js, use `detached: true` and kill the negative PID to kill the entire group.
  ```javascript
  const child = spawn('cmd', [], { detached: true });
  process.kill(-child.pid);
  ```
- **Explicit Timeouts**: Always wrap `fetch` with a timeout using `AbortController`.
  ```javascript
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 10000);
  await fetch(url, { signal: controller.signal });
  ```
- **Global Timeout**: Wrap the execution command with the `timeout` CLI utility to prevent CI/manual runs from hanging forever.
  ```bash
  timeout 120s node scripts/verify_metadata.js
  ```

### 2. Database Consistency
**Symptoms**:
- `401 Unauthorized` errors even when seeding users.
- `Relation does not exist` errors.

**Root Causes**:
- Reuse of existing DB state between runs.
- Schema changes not applied if `backend/infra/schema.sql` isn't re-run.

**Solutions**:
- **Explicit DB Reset**: The verification script should drop relevant tables (`DROP TABLE ... CASCADE`) and re-apply the schema (`backend/infra/schema.sql`) at the start. Do not rely on `npm run db:reset` if it's not strictly defined or reliable.

### 3. Git & Network Flakes
**Symptoms**:
- `git clone` hangs or fails inside the container.

**Solutions**:
- Use reliable, public repositories (e.g., `https://github.com/octocat/Hello-World.git`) for connectivity tests.
- Implement "Null Safety": If non-critical metadata (like git commit hash) fails to capture, log a warning but do not crash the request. Return `null` and handle it gracefully downstream.

### 4. Container Readiness
**Symptoms**:
- Connection refused when calling the worker API inside the container immediately after creation.

**Solutions**:
- **Polling/Wait**: The container might report "Running" before the application server inside is listening. Add a small delay or polling retry loop before making requests to the container.

### 5. Stale Docker Images (Worker Code Updates)
**Symptoms**:
- You modify `codex-worker` source code, but the worker behavior in the container doesn't change.
- Verification fails with checks that rely on new worker logic.

**Root Cause**:
- The workspace container runs an image (`codexrt-workspace:v0.1`) built from the worker code.
- Modifying local source files (`backend/packages/codex-worker/**`) DOES NOT automatically update the Docker image. The container continues to use the old image with old code.

**Solutions**:
- **Rebuild Image**: You MUST run `docker build` whenever you change code that gets copied into the container.
  ```bash
  docker build -t codexrt-workspace:v0.1 -f backend/infra/docker/workspace.Dockerfile .
  ```

### 6. Monorepo Symlinks & Caching (ts-node-dev)
**Symptoms**:
- You update a shared package (e.g., `@codex/shared`), run `npm run build` in it, but the consumer service (Orchestrator) still errors with type mismatches or old definitions.
- Restarting the script doesn't help if `ts-node-dev` or `tsc` cache is stale or following old symlinks.

**Solutions**:
- **Use `npm start` (Compiled JS)**: For verification scripts, prefer spawning the service using `npm start` (which usually runs `node dist/index.js`) rather than `npm run dev` (`ts-node-dev`). This ensures you are running the explicitly built artifacts, reducing caching ambiguity.
- **Rebuild Dependencies Explicitly**: Ensure you run `npm run build` in the dependency package before starting the verification.
## Reference Implementation
See `scripts/verify_metadata.js` for a robust example implementing these patterns.