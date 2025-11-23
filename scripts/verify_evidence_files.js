const { createDb } = require('../backend/packages/shared/dist/db');
const { WorkspaceManager } = require('../backend/packages/workspace-manager/dist/index');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Helper for fetch with timeout
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 10000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const response = await fetch(resource, {
    ...options,
    signal: controller.signal  
  });
  clearTimeout(id);
  return response;
}

async function run() {
  const db = createDb('postgres://postgres:postgrespassword@localhost:5432/codexrt');
  const wm = new WorkspaceManager();

  // Reset DB Tables
  console.log('Resetting DB tables...');
  try {
      // Resolve kysely - try local or shared
      let kyselyPath;
      try { kyselyPath = require.resolve('kysely'); } catch(e) {}
      if (!kyselyPath) {
          try { kyselyPath = require.resolve('../backend/packages/shared/node_modules/kysely'); } catch(e) {}
      }
      
      if (kyselyPath) {
        const { sql } = require(kyselyPath);
        await sql`DROP TABLE IF EXISTS runs CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS workspaces CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS projects CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS api_keys CASCADE`.execute(db);
        await sql`DROP TABLE IF EXISTS users CASCADE`.execute(db);
        
        // Read schema file
        const schemaSql = fs.readFileSync(path.resolve(__dirname, '../backend/infra/schema.sql'), 'utf8');
        const statements = schemaSql.split(';').filter(s => s.trim().length > 0);
        for (const stmt of statements) {
            await sql.raw(stmt).execute(db);
        }
        console.log('DB Reset complete.');
      } else {
          console.error('Could not load kysely to reset DB. Proceeding hoping DB is clean or compatible...');
      }
  } catch (e) {
      console.error('Failed to reset DB:', e);
      process.exit(1);
  }

  // Setup User & API Key
  console.log('Seeding user and api key...');
  const user = await db.insertInto('users')
    .values({ email: 'test@example.com', name: 'Test User', is_admin: true })
    .returning('id')
    .executeTakeFirstOrThrow();
  
  const apiKey = 'sk-test-12345';
  const tokenHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  
  await db.insertInto('api_keys')
    .values({ user_id: user.id, token_hash: tokenHash, label: 'Test Key' })
    .execute();

  // 1. Setup Orchestrator
  // In CI environment, Orchestrator is already running in Docker.
  // We skip spawning it to avoid port conflicts.
  console.log('Assuming Orchestrator is running (CI mode)...');

  // Poll for health check
  let attempts = 0;
  while (attempts < 60) {
      try {
          const health = await fetchWithTimeout('http://localhost:3000/healthz', { timeout: 2000 });
          if (health.ok) {
              console.log('Orchestrator is ready!');
              break;
          }
      } catch (e) {
          // ignore
      }
      await new Promise(r => setTimeout(r, 1000));
      attempts++;
  }
  
  if (attempts >= 60) {
      console.error('Orchestrator failed to start in time');
      process.kill(-orchestrator.pid); // Kill process group
      process.exit(1);
  }

  try {
      // 2. Create Project
      console.log('Creating project...');
      const pRes = await fetchWithTimeout('http://localhost:3000/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({ name: 'Evidence Test', repoUrl: 'https://github.com/octocat/Hello-World.git' }),
          timeout: 10000
      });
      if (!pRes.ok) throw new Error(`Create Project failed: ${pRes.status} ${await pRes.text()}`);
      const { projectId } = await pRes.json();
      console.log('Project created:', projectId);

      // 3. Open Workspace
      console.log('Opening workspace...');
      const wRes = await fetchWithTimeout(`http://localhost:3000/projects/${projectId}/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({}),
          timeout: 60000 
      });
      if (!wRes.ok) throw new Error(`Open Workspace failed: ${wRes.status} ${await wRes.text()}`);
      const { workspaceId } = await wRes.json();
      console.log('Workspace opened:', workspaceId);

      // 4. Run Message that triggers commands
      // Wait for worker to fully start
      console.log('Waiting for worker to be ready...');
      await new Promise(r => setTimeout(r, 5000));

      console.log('Sending message...');
      // We ask to create a file to ensure some git diff happens
      const mRes = await fetchWithTimeout(`http://localhost:3000/projects/${projectId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({ text: 'create evidence_test.txt' }),
          timeout: 60000
      });
      if (!mRes.ok) throw new Error(`Message failed: ${mRes.status} ${await mRes.text()}`);
      const { runId } = await mRes.json();
      console.log('Run completed:', runId);

      // 5. Verify Evidence Files inside Container
      const workspace = await db.selectFrom('workspaces').selectAll().where('id', '=', workspaceId).executeTakeFirst();
      const containerId = workspace.container_id;
      console.log(`Inspecting container ${containerId} for evidence...`);

      // Verify command_log.jsonl
      try {
        const cmdLog = execSync(`docker exec ${containerId} cat /workspace/evidence/${runId}/command_log.jsonl`).toString();
        console.log('Found command_log.jsonl');
        // Parse first line to verify JSON structure
        const lines = cmdLog.trim().split('\n');
        if (lines.length === 0) throw new Error('Empty command log');
        const entry = JSON.parse(lines[0]);
        if (!entry.ts || !entry.command) throw new Error('Invalid command log entry format');
        console.log('PASS: Command log contains:', entry.command);
      } catch (e) {
        console.error('FAIL: command_log.jsonl check failed:', e.message);
        process.exit(1);
      }

      // Verify outputs.json
      try {
        const outputs = execSync(`docker exec ${containerId} cat /workspace/evidence/${runId}/outputs.json`).toString();
        console.log('Found outputs.json');
        const manifest = JSON.parse(outputs);
        if (manifest.runId !== runId) throw new Error('RunID mismatch in manifest');
        if (!manifest.diffSummary) throw new Error('Missing diffSummary in manifest');
        console.log('PASS: Outputs manifest verified:', JSON.stringify(manifest.diffSummary));
      } catch (e) {
        console.error('FAIL: outputs.json check failed:', e.message);
        process.exit(1);
      }

      // 6. Verify DB env_snapshot
      const run = await db.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirst();
      if (!run.env_snapshot) {
          console.error('FAIL: env_snapshot missing');
          process.exit(1);
      }
      
      const snapshot = run.env_snapshot; // Already parsed JSONB if using Kysely with correct types, or might need casting?
      // Kysely usually handles JSONB parsing.
      console.log('Env snapshot:', JSON.stringify(snapshot));
      
      if (snapshot.evidencePath !== `/workspace/evidence/${runId}`) {
          console.error('FAIL: evidencePath missing or incorrect in snapshot');
          process.exit(1);
      }
      if (!snapshot.hasCommandLog || !snapshot.hasOutputsManifest) {
          console.error('FAIL: hasCommandLog/hasOutputsManifest missing in snapshot');
          process.exit(1);
      }
      console.log('PASS: DB env_snapshot verified.');

  } catch (err) {
      console.error('Verification Failed:', err);
      process.exit(1);
  } finally {
      await db.destroy();
  }
}

run();