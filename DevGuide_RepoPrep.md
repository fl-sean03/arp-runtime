Document 1 — Repo Prep & GitHub Push Guide (for Junior Dev)

Goal: Get the ARP Runtime repo into a clean, production-ready state and push it to GitHub without leaking secrets, and with everything needed for EC2 deployment later.

Assume:

You’re working on your local dev machine.

The codebase for the Remote Codex Agent Runtime (v0.1–v0.3) already exists and is working.

Node, Docker, and docker-compose are installed locally.

I’ll refer to placeholders like:

<GITHUB_ORG_OR_USER> — your GitHub username or org.

<REPO_NAME> — the repo name you pick (e.g. arp-runtime).

1. Ensure secrets are not in the repo

In the root of the project, create or update .gitignore with at least:

# Node / build artifacts
node_modules/
dist/
build/
coverage/

# Env / secrets
.env
.env.*
!.env.example

# Docker artifacts
*.log
evidence/


Search the repo for obvious secrets:

OPENAI_API_KEY

DB passwords

Any other API keys or private URLs.

If you find any:

Move those values into a local .env file that is not committed.

Replace hardcoded values in code with process.env.<VAR_NAME>.

Create .env.example in the root with placeholders, not real secrets:

# Example env values - DO NOT USE IN PROD
DATABASE_URL=postgres://arp:password@db:5432/arp
OPENAI_API_KEY=sk-REPLACE_ME
RUNS_PER_DAY_LIMIT_DEFAULT=500
WORKSPACE_COLD_TTL_DAYS=30
EVIDENCE_TTL_DAYS=180

# Optional:
PORT=8080
LOG_LEVEL=info


This file is committed. It shows others what env vars exist, without exposing actual values.

2. Docker & compose sanity

We need two modes:

Dev: binds your local source into the container, good for local work.

Prod: uses built images, no bind-mount of source.

Ensure there is a Dockerfile for the orchestrator (Node service). Minimal pattern:

# Build stage
FROM node:20-bullseye AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build  # or equivalent

# Runtime stage
FROM node:20-bullseye
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package*.json ./
RUN npm install --omit=dev
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]


Adjust commands to your actual build system (pnpm, yarn, etc.), but the key is:

One image that runs the orchestrator using compiled JS, not ts-node/nodemon.

Add or clean up the dev compose file (if not present):

docker-compose.dev.yml:

version: "3.9"
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: arp
      POSTGRES_PASSWORD: arp
      POSTGRES_DB: arp
    ports:
      - "5432:5432"
    volumes:
      - arp-dev-db:/var/lib/postgresql/data

  orchestrator:
    build: .
    env_file:
      - .env
    depends_on:
      - db
    ports:
      - "8080:8080"
    volumes:
      - .:/app
      - /var/run/docker.sock:/var/run/docker.sock

volumes:
  arp-dev-db:


Add a prod compose file (this will be used on EC2):

docker-compose.yml:

version: "3.9"
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: arp
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: arp
    volumes:
      - arp-db-data:/var/lib/postgresql/data

  orchestrator:
    image: ghcr.io/<GITHUB_ORG_OR_USER>/<REPO_NAME>:latest
    env_file:
      - .env.production
    depends_on:
      - db
    ports:
      - "8080:8080"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - arp-evidence:/var/arp/evidence

volumes:
  arp-db-data:
  arp-evidence:


For now it’s fine if this image doesn’t exist yet; the other dev will hook CI/CD to build/push.

Just make sure the image name matches what CI/CD will use later.

3. Migrations & startup commands

Make sure there is a single, documented migration command. For example:

npm run migrate

Whatever it is, it should:

Apply all DB schema changes (users, api_keys, projects, workspaces, runs, evidence_bundles, etc.).

Make sure there is a single production start script in package.json:

"scripts": {
  "start": "node dist/index.js",
  "build": "tsc",         // or your build tool
  "migrate": "node scripts/migrate.js",
  "ci": "./ci_v0.3.sh"
}


The exact commands will match what you already use; the point is: no ambiguity about how to run the service in prod.

4. Local verification before first push

Build the image locally:

docker build -t arp-orchestrator-test .


Run dev stack:

docker compose -f docker-compose.dev.yml up


Make sure the orchestrator comes up and can:

Connect to DB.

Run the v0.3 CI script if triggered.

Run the integrated regression script:

chmod +x ci_v0.3.sh
./ci_v0.3.sh


This should be green before you push.

If any test fails, fix it now. Do not push a broken v0.3 baseline.

5. Initialize Git repository (if not already)

If this project isn’t already a git repo:

git init
git add .
git commit -m "Initial ARP runtime (v0.3) commit"


If it is already a git repo, just ensure your working tree is clean:

git status

6. Create GitHub repo and push

On GitHub:

Create a new repo:

Name: <REPO_NAME>

Visibility: private (recommended for now).

Add the remote:

git remote add origin git@github.com:<GITHUB_ORG_OR_USER>/<REPO_NAME>.git


(or HTTPS if you prefer).

Push the existing local repo:

git push -u origin main


If your default branch is master, either rename or adjust commands.

Confirm on GitHub:

.gitignore is there.

.env is not present.

.env.example, Dockerfile, docker-compose.yml, docker-compose.dev.yml, ci_v0.3.sh, etc. are in the repo.

At that point, the repo is ready for the EC2 dev to use and for CI/CD wiring.