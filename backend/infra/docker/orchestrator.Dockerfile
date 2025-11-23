# Build stage
FROM node:20-slim AS build

# Install pnpm and build dependencies
RUN npm install -g pnpm
RUN apt-get update && apt-get install -y zip

WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy all backend packages (since they are inter-dependent)
COPY backend/packages ./backend/packages

# Install dependencies (including devDependencies for building)
RUN pnpm install

# Build shared, workspace-manager, and orchestrator
WORKDIR /app/backend/packages/shared
RUN pnpm run build

WORKDIR /app/backend/packages/workspace-manager
RUN pnpm run build

WORKDIR /app/backend/packages/orchestrator
RUN pnpm run build

# Runtime stage
FROM node:20-slim

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy root files needed for runtime
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy built artifacts from build stage
# We need to copy the package.json files for workspaces to be resolved correctly
COPY --from=build /app/backend/packages/shared/package.json ./backend/packages/shared/package.json
COPY --from=build /app/backend/packages/shared/dist ./backend/packages/shared/dist

COPY --from=build /app/backend/packages/workspace-manager/package.json ./backend/packages/workspace-manager/package.json
COPY --from=build /app/backend/packages/workspace-manager/dist ./backend/packages/workspace-manager/dist

COPY --from=build /app/backend/packages/orchestrator/package.json ./backend/packages/orchestrator/package.json
COPY --from=build /app/backend/packages/orchestrator/dist ./backend/packages/orchestrator/dist

# Install only production dependencies
RUN pnpm install --prod

# Expose port
EXPOSE 3000

# Start orchestrator
WORKDIR /app/backend/packages/orchestrator
CMD ["node", "dist/index.js"]