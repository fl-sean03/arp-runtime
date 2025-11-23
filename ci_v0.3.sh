#!/bin/bash

# ==============================================
# v0.3 Master Verification Script
# Runs all v0.3 feature tests + v0.2 regression tests + v0.1 regression tests
# ==============================================

set -e # Fail fast

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[CI v0.3] INFO: $1${NC}"
}

log_error() {
    echo -e "${RED}[CI v0.3] ERROR: $1${NC}"
}

log_warn() {
    echo -e "${YELLOW}[CI v0.3] WARN: $1${NC}"
}

# Ensure we are in the root directory
if [ ! -f "package.json" ]; then
    log_error "Must be run from project root"
    exit 1
fi

log_info "Checking Orchestrator health..."
if ! curl -s "http://localhost:3000/projects" > /dev/null; then
    log_error "Orchestrator is not running at http://localhost:3000"
    log_info "Please start the environment: docker-compose -f backend/infra/docker/compose.yml up -d"
    exit 1
fi

log_info "Starting v0.3 Verification Suite..."

run_test() {
    local script=$1
    log_info "Running $script..."
    if node "$script"; then
        log_info "PASS: $script"
    else
        log_error "FAIL: $script"
        exit 1
    fi
}

# 1. v0.2 Verification Suite
log_info "Running v0.2 Verification Suite..."
run_test "scripts/verify_isolation.js"
run_test "scripts/verify_runs.js"
run_test "scripts/verify_streaming.js"
run_test "scripts/verify_observability.js"

# 2. v0.3 Verification Suite
log_info "Running v0.3 Verification Suite..."
run_test "scripts/verify_metadata.js"
run_test "scripts/verify_evidence_files.js"
run_test "scripts/verify_evidence_bundle.js"
run_test "scripts/verify_gc.js"

# 3. Run v0.1 Regression (Patched verify_advanced.sh)
log_info "Running v0.1 Regression Suite (verify_advanced.sh)..."
if [ -f "./verify_advanced.sh" ]; then
    chmod +x ./verify_advanced.sh
    if ./verify_advanced.sh; then
        log_info "PASS: verify_advanced.sh"
    else
        log_error "FAIL: verify_advanced.sh"
        exit 1
    fi
else
    log_error "verify_advanced.sh not found!"
    exit 1
fi

log_info "=============================================="
log_info "ALL v0.3 CHECKS PASSED SUCCESSFULLY"
log_info "=============================================="
exit 0