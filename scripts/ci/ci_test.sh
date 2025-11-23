#!/bin/bash

# ==============================================
# Hardening Task 4: CI Integration Script
# Single entry point for CI systems.
# ==============================================

# --- Configuration ---
DOCKER_COMPOSE_FILE="backend/infra/docker/compose.yml"
ORCHESTRATOR_URL="http://localhost:3000"
MAX_RETRIES=30
RETRY_DELAY=2

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# --- Helper Functions ---

log_info() {
    echo -e "${GREEN}[CI] INFO: $1${NC}"
}

log_warn() {
    echo -e "${YELLOW}[CI] WARN: $1${NC}"
}

log_error() {
    echo -e "${RED}[CI] ERROR: $1${NC}"
}

cleanup() {
    echo ""
    log_info "Cleaning up environment..."
    
    # Kill any stray workspace containers created by the Orchestrator
    # Since they might not have a consistent name, we filter by the image they use.
    log_info "Removing stray workspace containers (by image)..."
    docker ps -a --filter "ancestor=codexrt-workspace:v0.1" -q | xargs -r docker rm -f

    if [ "$CI" == "true" ] || [ "$CI" == "1" ]; then
        log_info "CI environment detected. Tearing down completely."
        docker-compose -f "$DOCKER_COMPOSE_FILE" down -v
    else
        log_info "Local run detected. Stopping containers but preserving volumes (use -v manually if needed)."
        docker-compose -f "$DOCKER_COMPOSE_FILE" down
    fi
}

wait_for_orchestrator() {
    log_info "Waiting for Orchestrator to be ready..."
    local count=0
    while [ $count -lt $MAX_RETRIES ]; do
        # Use /health if available, otherwise check root or project list which returns 200
        if curl -s "$ORCHESTRATOR_URL/projects" > /dev/null; then
            log_info "Orchestrator is UP!"
            return 0
        fi
        count=$((count + 1))
        echo -n "."
        sleep $RETRY_DELAY
    done
    log_error "Orchestrator failed to start within timeout."
    return 1
}

# --- Main Execution ---

# Trap exit for cleanup
trap cleanup EXIT

log_info "Starting CI Test Suite..."

# 1. Environment Setup
log_info "Building and starting services..."
docker-compose -f "$DOCKER_COMPOSE_FILE" up -d --build

if ! wait_for_orchestrator; then
    log_error "Environment setup failed."
    exit 1
fi

# 2. Run Tests

# Test Suite 1: Advanced Verification (Mocks & Logic)
log_info "Running Suite 1: Advanced Verification (verify_advanced.sh)..."
chmod +x scripts/verify_advanced.sh
if ./scripts/verify_advanced.sh; then
    log_info "Suite 1 PASSED."
else
    log_error "Suite 1 FAILED."
    exit 1
fi

# Test Suite 2: Real Codex Verification (Conditional)
if [ -n "$OPENAI_API_KEY" ]; then
    log_info "OPENAI_API_KEY detected. Running Suite 2: Real Codex Verification (verify_real_codex.sh)..."
    chmod +x scripts/verify_real_codex.sh
    if ./scripts/verify_real_codex.sh; then
        log_info "Suite 2 PASSED."
    else
        log_error "Suite 2 FAILED."
        exit 1
    fi
else
    log_warn "OPENAI_API_KEY not found. Skipping Suite 2 (Real Codex Verification)."
fi

log_info "ALL TESTS COMPLETED SUCCESSFULLY."
exit 0