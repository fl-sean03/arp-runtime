const { Client } = require('pg');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

// Load environment
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DB_URL = process.env.POSTGRES_URL || 'postgres://postgres:postgrespassword@localhost:5432/codexrt';
const ORCHESTRATOR_URL = 'http://localhost:3000';

async function main() {
  const client = new Client({ connectionString: DB_URL });
  
  try {
    // Check Orchestrator Health
    console.log('--- checking orchestrator health ---');
    const health = await fetch(`${ORCHESTRATOR_URL}/healthz`).then(r => r.json()).catch(() => ({ ok: false }));
    if (!health.ok) {
        throw new Error('Orchestrator is not running! Please start it first.');
    }
    console.log('Orchestrator is ready.');

    console.log('--- connecting to db ---');
    await client.connect();

    // 1. Reset Database
    console.log('--- resetting database ---');
    await client.query('DROP TABLE IF EXISTS runs CASCADE');
    await client.query('DROP TABLE IF EXISTS workspaces CASCADE');
    await client.query('DROP TABLE IF EXISTS projects CASCADE');
    await client.query('DROP TABLE IF EXISTS api_keys CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');
    
    const schemaSql = `
      CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email TEXT UNIQUE,
          name TEXT,
          is_admin BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS api_keys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id),
          token_hash TEXT NOT NULL,
          label TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          revoked_at TIMESTAMP WITH TIME ZONE
      );

      CREATE TABLE IF NOT EXISTS projects (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          repo_url TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS workspaces (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          state TEXT NOT NULL,
          container_id TEXT,
          volume_name TEXT NOT NULL,
          thread_id TEXT,
          last_active_at TIMESTAMP DEFAULT NOW(),
          idle_expires_at TIMESTAMP,
          image_name TEXT,
          image_digest TEXT,
          runtime_metadata JSONB
      );

      CREATE TABLE IF NOT EXISTS runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        final_text TEXT,
        diff TEXT,
        test_output TEXT,
        error_message TEXT,
        started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        finished_at TIMESTAMP WITH TIME ZONE,
        duration_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        git_commit TEXT,
        image_name TEXT,
        image_digest TEXT,
        env_snapshot JSONB
    );
    `;
    await client.query(schemaSql);
    console.log('Database reset and schema applied.');

    // 2. Create User
    console.log('--- creating user ---');
    const user = await createUser(client, 'user@example.com', 'Test User');
    console.log(`User created: ${user.id}`);

    // 3. Create Project
    console.log('--- creating project ---');
    const project = await createProject(user.key, 'Test Project', 'https://github.com/octocat/Hello-World.git');
    console.log(`Project created: ${project.projectId}`);

    // 4. Open Project
    console.log('--- opening project ---');
    await openProject(user.key, project.projectId);
    console.log('Project opened and workspace warm.');

    // 5. Run Message (Success Case)
    console.log('--- running message (success) ---');
    const msgRes = await sendMessage(user.key, project.projectId, 'echo "hello"');
    console.log('Message response:', msgRes);
    
    if (!msgRes.runId) throw new Error('No runId in message response');
    if (!msgRes.finalText) throw new Error('No finalText in message response');

    // 6. Verify Run Record
    console.log('--- verifying run record ---');
    const run = await getRun(user.key, msgRes.runId);
    console.log('Run details:', run);

    if (run.status !== 'succeeded') throw new Error(`Run status is ${run.status}, expected succeeded`);
    if (run.prompt !== 'echo "hello"') throw new Error('Run prompt mismatch');
    if (run.final_text !== msgRes.finalText) throw new Error('Run final_text mismatch');
    if (!run.started_at || !run.finished_at || !run.duration_ms) throw new Error('Run timing missing');

    // 7. List Runs
    console.log('--- listing runs ---');
    const runsList = await listRuns(user.key, project.projectId);
    console.log(`Found ${runsList.length} runs`);
    if (runsList.length !== 1) throw new Error('Expected 1 run in list');
    if (runsList[0].id !== msgRes.runId) throw new Error('Listed run ID mismatch');

    // 8. Run Message (Failure Case - Invalid Command via mocked logic or security block)
    // Actually our mock handles most things gracefully, but let's try a blocked command if the worker implements it.
    // The worker blocks 'rm', 'curl' etc.
    console.log('--- running message (failure) ---');
    
    // We expect the worker to return a response with "Command rejected" or throw an error.
    // If it throws 500, we catch it. If it returns text "rejected", the run is successful technically (Orchestrator view),
    // but the CONTENT implies failure.
    // However, the worker throws new Error if response is not ok.
    // Let's try to trigger a real worker error?
    // The worker code: if (!response.ok) throw...
    // The worker endpoint catches errors and sends 500.
    // So if we send something that causes worker to crash or 500, Orchestrator catches it.
    
    // BUT the worker implementation I read has:
    // try { ... } catch (error) { reply.status(500)... }
    // So if I can make worker throw, Orchestrator sees 500.
    
    // Let's try a command that might not be in the whitelist but handled by "Command Failed"?
    // The worker code catches exec errors and returns { text: Command Failed... } which is a 200 OK from worker perspective.
    // This counts as a SUCCEEDED run in Orchestrator (it executed and returned text).
    
    // To test FAILED status in Orchestrator, we need the worker request to fail (network, or 500).
    // Let's use a "poison pill" if we had one, or rely on something that crashes the worker?
    // Or we can manually insert a fail for testing?
    
    // Actually, let's just accept that "Command rejected" is a valid result.
    // To test the 'failed' status logic in Orchestrator, we can try to force a failure.
    // Maybe we can stop the workspace container and then try to send a message?
    // But lockManager checks for warm workspace first.
    
    // Let's just trust the code logic for now, or try to find a way to make fetch fail.
    // If I stop the container manually, fetch will fail.
    
    console.log('--- stopping container to force failure ---');
    // Get container ID
    const wsRes = await client.query('SELECT container_id FROM workspaces WHERE project_id = $1', [project.projectId]);
    const containerId = wsRes.rows[0].container_id;
    const { exec } = require('child_process');
    await new Promise((resolve) => exec(`docker stop ${containerId}`, resolve));
    
    try {
        await sendMessage(user.key, project.projectId, 'should fail');
        throw new Error('Message should have failed!');
    } catch (e) {
        console.log('Message failed as expected:', e.message);
    }
    
    // Check if run was recorded as failed
    // Wait a bit for async update if any (though it's awaited in the code)
    const failedRunRes = await client.query('SELECT * FROM runs WHERE status = \'failed\' ORDER BY started_at DESC LIMIT 1');
    if (failedRunRes.rows.length === 0) {
        throw new Error('No failed run recorded!');
    }
    const failedRun = failedRunRes.rows[0];
    console.log('Failed run recorded:', failedRun.id, failedRun.error_message);
    
    if (!failedRun.error_message) throw new Error('Error message not recorded');

    console.log('ALL TESTS PASSED SUCCESSFULLY.');

  } catch (err) {
    console.error('Test Failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

async function createUser(client, email, name) {
    const userRes = await client.query(
        'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id',
        [email, name]
    );
    const userId = userRes.rows[0].id;
    const rawKey = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    await client.query(
        'INSERT INTO api_keys (user_id, token_hash, label) VALUES ($1, $2, $3)',
        [userId, hash, 'test-key']
    );
    return { id: userId, key: rawKey };
}

async function createProject(apiKey, name, repoUrl) {
    const res = await fetch(`${ORCHESTRATOR_URL}/projects`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify({ name, repoUrl })
    });
    if (!res.ok) throw new Error(`Create Project failed: ${res.status} ${await res.text()}`);
    return await res.json();
}

async function openProject(apiKey, projectId) {
    const res = await fetch(`${ORCHESTRATOR_URL}/projects/${projectId}/open`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey }
    });
    if (!res.ok) throw new Error(`Open Project failed: ${res.status} ${await res.text()}`);
    return await res.json();
}

async function sendMessage(apiKey, projectId, text) {
    const res = await fetch(`${ORCHESTRATOR_URL}/projects/${projectId}/message`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
        },
        body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error(`Send Message failed: ${res.status} ${await res.text()}`);
    return await res.json();
}

async function listRuns(apiKey, projectId) {
    const res = await fetch(`${ORCHESTRATOR_URL}/projects/${projectId}/runs`, {
        method: 'GET',
        headers: { 'x-api-key': apiKey }
    });
    if (!res.ok) throw new Error(`List Runs failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.runs;
}

async function getRun(apiKey, runId) {
    const res = await fetch(`${ORCHESTRATOR_URL}/runs/${runId}`, {
        method: 'GET',
        headers: { 'x-api-key': apiKey }
    });
    if (!res.ok) throw new Error(`Get Run failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.run;
}

main();