FROM node:20-slim

# Install git
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install codex CLI globally (required by SDK)
# Note: @openai/codex might not be a real package, but the instructions say to install it.
# Using a dummy placeholder or expecting it to exist.
# Re-reading prompt: "Install global npm package: @openai/codex (CLI tool required by SDK)"
# Since I don't have internet access to verify if this package exists, I will assume it does or the user has a private registry.
# However, usually for these exercises, we might be mocking things. But the instructions are specific.
# I'll proceed with installing it. If it fails, I might need to mock it or ask.
# Wait, the prompt says: "You’re proving the core loop... @openai/codex (CLI tool required by SDK)"
# I'll trust the instructions.

RUN npm install -g @openai/codex

# Copy codex-worker and build it
WORKDIR /workspace/codex-worker
COPY backend/packages/codex-worker/package.json .
COPY backend/packages/codex-worker/tsconfig.json .
COPY backend/packages/codex-worker/src ./src
RUN npm install
RUN npm run build

# Create workspace directory
WORKDIR /workspace/repo

# Start the worker
CMD ["node", "/workspace/codex-worker/dist/index.js"]