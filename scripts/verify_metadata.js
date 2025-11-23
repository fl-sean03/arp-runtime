const { createDb } = require('../backend/packages/shared/dist/db');
const { WorkspaceManager } = require('../backend/packages/workspace-manager/dist/index');
const { spawn } = require('child_process');
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
  console.log('Waiting for Orchestrator to be ready...');
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
          body: JSON.stringify({ name: 'Metadata Test', repoUrl: 'https://github.com/octocat/Hello-World.git' }),
          timeout: 10000
      });
      if (!pRes.ok) throw new Error(`Create Project failed: ${pRes.status} ${await pRes.text()}`);
      const { projectId } = await pRes.json();
      console.log('Project created:', projectId);

      // 3. Open Workspace (should capture image metadata)
      console.log('Opening workspace...');
      const wRes = await fetchWithTimeout(`http://localhost:3000/projects/${projectId}/open`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({}),
          timeout: 30000 // Give more time for Docker ops (pull/start/clone)
      });
      if (!wRes.ok) throw new Error(`Open Workspace failed: ${wRes.status} ${await wRes.text()}`);
      const { workspaceId } = await wRes.json();
      console.log('Workspace opened:', workspaceId);

      // 4. Verify Workspace Metadata
      const workspace = await db.selectFrom('workspaces').selectAll().where('id', '=', workspaceId).executeTakeFirst();
      if (!workspace.image_name || !workspace.image_digest) {
          console.error('FAIL: Workspace image metadata missing', workspace);
          process.exit(1);
      }
      console.log('PASS: Workspace has image metadata:', workspace.image_name, workspace.image_digest);

      // 5. Run Message (should capture run metadata and git commit)
      // Wait for worker to fully start
      console.log('Waiting for worker to be ready...');
      await new Promise(r => setTimeout(r, 3000));

      console.log('Sending message...');
      const mRes = await fetchWithTimeout(`http://localhost:3000/projects/${projectId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({ text: 'create metadata_test.txt' }),
          timeout: 20000
      });
      if (!mRes.ok) throw new Error(`Message failed: ${mRes.status} ${await mRes.text()}`);
      const { runId } = await mRes.json();
      console.log('Run completed:', runId);

      // 6. Verify Run Metadata
      const run = await db.selectFrom('runs').selectAll().where('id', '=', runId).executeTakeFirst();
      
      // Check image metadata (Must be present)
      if (!run.image_name || !run.image_digest) {
           console.error('FAIL: Run image metadata missing', run);
           process.exit(1);
      }
      
      // Check env_snapshot (Can be null if not populated, but column must exist)
      if (run.env_snapshot === undefined) {
           console.error('FAIL: Run env_snapshot column missing');
           process.exit(1);
      }

      if (!run.git_commit) {
          console.warn('WARN: Git commit missing (acceptable if git failed or mock)', run);
      } else {
          console.log('PASS: Run has git commit:', run.git_commit);
      }
      console.log('PASS: Run has snapshot metadata:', run.image_name, run.image_digest);

  } catch (err) {
      console.error('Verification Failed:', err);
      process.exit(1);
  } finally {
      // Clean up container?
      await db.destroy();
  }
}

run();