#!/bin/bash
echo "Cleaning up codex environment..."

# 1. Stop Docker containers
echo "Stopping Docker containers..."
docker stop docker-orchestrator-1 || true
# We might want to keep postgres running if we use it, but typically we want a clean slate or at least stop the app.
# If postgres is running in docker, we might need it. The verification script connects to localhost:5432.
# If postgres is in docker-compose, 'docker-orchestrator-1' implies it might be part of a compose stack.
# Let's see if we should stop postgres too. The verification script resets the DB tables, so keeping the DB running is fine.
# But if we want to be safe, we can just stop the orchestrator.

# Stop any other containers that might be blocking ports
docker ps -q --filter "publish=3000" | xargs -r docker stop

# Remove workspace containers (codexrt-workspace:v0.1)
echo "Removing workspace containers..."
# More aggressive cleanup: remove ALL containers except codex_db (postgres) and maybe orchestrator if we want to keep it (but usually we stop it)
# We preserve codex_db to avoid losing data or restart overhead if external
docker ps -a --format '{{.ID}} {{.Names}}' | grep -v "codex_db" | awk '{print $1}' | xargs -r docker rm -f

# 2. Kill local processes on port 3000
echo "Killing local processes on port 3000..."
fuser -k 3000/tcp || true

# 3. Kill any lingering node processes related to the orchestrator
echo "Killing lingering node processes..."
pkill -f "ts-node-dev" || true
pkill -f "backend/packages/orchestrator/src/index.ts" || true

echo "Cleanup complete."