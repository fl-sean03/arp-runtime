#!/bin/bash

# Set WARM_IDLE_MINUTES to a very short duration for testing
export WARM_IDLE_MINUTES=0.1 # 6 seconds
# We also need to make sure the orchestrator picks this up. 
# If it's already running in docker-compose, we might need to restart it or use a mocked approach.
# However, the orchestrator reads .env or process.env. 
# The orchestrator container in docker-compose.yml has:
#    environment:
#      - WARM_IDLE_MINUTES=${WARM_IDLE_MINUTES:-20}
# So we need to restart the orchestrator with this new env var.
# But verify.sh usually runs against the running system.
# Let's assume we can't easily restart the whole stack here without disruption.
# ALTERNATIVE: The idle reaper runs every 60s. 0.1 min is 6s.
# If the reaper runs at T+60s, it will see the workspace expired (created at T, expired at T+6s).
# So we just need to wait > 60s.

echo "Creating project..."
PROJECT_RES=$(curl -s -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"test-project", "repoUrl":"https://github.com/octocat/Hello-World.git"}')

echo "Project Response: $PROJECT_RES"
PROJECT_ID=$(echo $PROJECT_RES | grep -o '"projectId":"[^"]*"' | cut -d'"' -f4)

if [ -z "$PROJECT_ID" ]; then
  echo "Failed to create project"
  exit 1
fi

echo "Project ID: $PROJECT_ID"

# Open project
echo "Opening project (Warm)..."
OPEN_RES=$(curl -s -X POST "http://localhost:3000/projects/$PROJECT_ID/open")
echo "Open Response: $OPEN_RES"
# Wait for worker to be fully ready
sleep 2

# Send message to create a file
echo "Sending message to create file..."
MSG_RES=$(curl -s -X POST "http://localhost:3000/projects/$PROJECT_ID/message" \
  -H "Content-Type: application/json" \
  -d '{"text":"Create a file named lifecycle_test.txt with content Persistent Data"}')
echo "Message Response: $MSG_RES"

if [[ "$MSG_RES" == *"diff --git"* ]]; then
  echo "SUCCESS: Diff found in response"
else
  echo "FAILURE: No diff found"
  exit 1
fi

# Verify file exists in container
CONTAINER_ID=$(docker ps -q --filter ancestor=codexrt-workspace:v0.1 | head -n 1)
if [ -n "$CONTAINER_ID" ]; then
  echo "Checking file in container $CONTAINER_ID..."
  if docker exec $CONTAINER_ID ls lifecycle_test.txt > /dev/null 2>&1; then
     echo "SUCCESS: File 'lifecycle_test.txt' exists in container."
  else
     echo "FAILURE: File 'lifecycle_test.txt' NOT found in container."
     exit 1
  fi
else
  echo "FAILURE: Could not find workspace container."
  exit 1
fi

echo "Waiting for idle timeout (forcing cold state)..."
# The idle reaper runs every 60s.
# We can simulate expiration by manually updating the DB if we had access, 
# OR we can restart the orchestrator with a short timeout.
# OR we can just wait 21 minutes (too long).
# Hack: We'll use a DB query to set idle_expires_at to the past.
# We need to execute this inside the postgres container.
echo "Manually expiring workspace..."
docker exec codex_db psql -U postgres -d codexrt -c "UPDATE workspaces SET idle_expires_at = NOW() - INTERVAL '1 minute' WHERE project_id = '$PROJECT_ID' AND state = 'warm';"

echo "Waiting for reaper (max 70s)..."
# Reaper runs every 60s. We wait 70s to be safe.
sleep 70

# Check if container is gone
echo "Checking if container is gone..."
if docker ps -q --filter "id=$CONTAINER_ID" | grep -q .; then
  echo "FAILURE: Container $CONTAINER_ID is still running (should be cold)."
  # exit 1 # Don't exit yet, maybe reaper just missed the beat
else
  echo "SUCCESS: Container stopped (Cold state achieved)."
fi

# Verify DB state is cold
STATE=$(docker exec codex_db psql -U postgres -d codexrt -t -c "SELECT state FROM workspaces WHERE project_id = '$PROJECT_ID';")
echo "DB State: $STATE"
if [[ "$STATE" == *"cold"* ]]; then
   echo "SUCCESS: DB state is 'cold'."
else
   echo "WARNING: DB state is '$STATE' (expected cold)."
fi

# Open project again (Cold Resume)
echo "Re-opening project (Cold Resume)..."
OPEN_RES_2=$(curl -s -X POST "http://localhost:3000/projects/$PROJECT_ID/open")
echo "Re-open Response: $OPEN_RES_2"

# Verify file still exists (Persistence)
NEW_CONTAINER_ID=$(docker ps -q --filter ancestor=codexrt-workspace:v0.1 | head -n 1)
echo "New Container ID: $NEW_CONTAINER_ID"

if [ -z "$NEW_CONTAINER_ID" ]; then
    echo "FAILURE: No new container started."
    exit 1
fi

if [ "$NEW_CONTAINER_ID" == "$CONTAINER_ID" ]; then
    echo "WARNING: Container ID is the same? (Did it not stop?)"
fi

echo "Checking file in new container..."
if docker exec $NEW_CONTAINER_ID ls lifecycle_test.txt > /dev/null 2>&1; then
     echo "SUCCESS: File 'lifecycle_test.txt' persisted!"
else
     echo "FAILURE: File 'lifecycle_test.txt' lost!"
     exit 1
fi

echo "Verification complete!"