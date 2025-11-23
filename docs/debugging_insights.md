# Debugging Insights & Lessons Learned

## Docker Interaction
*   **Stream Hanging**: We encountered persistent hanging issues when using `dockerode`'s `container.exec` with attached streams (`AttachStdout: true`, `hijack: true`). Even for simple commands, the stream `end` event would sometimes not fire, or the operation would block indefinitely.
*   **CLI Fallback**: Switching to `docker exec` via the host CLI (`child_process.exec`) proved to be a robust workaround for file operations. Specifically, using `echo "BASE64_CONTENT" | base64 -d > "TARGET_FILE"` avoids complex stream handling and works reliably for text files.
*   **PutArchive Issues**: `container.putArchive` (using `tar-stream`) also exhibited hanging behavior in this environment, possibly due to stream consumption issues or Docker daemon interaction quirks.

## Process Management
*   **Zombie Processes**: Aggressive process killing (`pkill -f "node"`) can leave `pnpm` or `ts-node-dev` in inconsistent states, or fail to kill child processes effectively. This leads to port conflicts (EADDRINUSE) and confusion when logs are not updated.
*   **Log Staleness**: Redirecting output to files (`> log.txt`) for background processes can lead to stale reads if the process restarts or if buffering delays writes. Using foreground execution or carefully managing log files is recommended.

## Verification Strategy
*   **Client Timeouts**: Verification scripts should implement strict timeouts and progress logging (e.g., printing dots for received events) to distinguish between "connecting" and "receiving data" states.
*   **Race Conditions**: We identified a race condition where `putFile` (writing event logs) was racing with `EvidenceBuilder` (archiving the directory). Ensuring `putFile` completes *before* triggering evidence build is critical for data integrity.
*   **Verification Scripts**: 
    *   `scripts/verify_streaming.js`: Validates SSE event shapes and checks container persistence directly.
    *   `scripts/verify_evidence_bundle.js`: Validates the end-to-end evidence bundle (ZIP) contains all required files including `events.jsonl`. Note: This script does not use the streaming endpoint, highlighting the need for consistency.

## Code Management & Architecture
*   **Build Artifacts**: When running from `dist/`, ensure `pnpm -r build` is run after source changes. Verification can fail silently if the running process is using stale build artifacts.
*   **Endpoint Consistency**: Features like "Evidence Collection" must be implemented consistently across all execution paths (Streaming vs. Non-Streaming). We initially missed updating the non-streaming `POST /message` endpoint, which caused `verify_evidence_bundle.js` to fail even though `verify_streaming.js` passed.
*   **Diff Application**: Automated diff application can sometimes be tricky with commented-out code blocks. Always verify the file content after applying changes to ensure the intended logic is active (e.g., uncommented).