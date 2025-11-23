const { Client } = require('pg');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

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

    // 1. Reset Database (Re-using logic from verify_runs.js to ensure clean slate)
    console.log('--- resetting database ---');
    await client.query('DROP TABLE IF EXISTS evidence_bundles CASCADE');
    await client.query('DROP TABLE IF EXISTS runs CASCADE');
    await client.query('DROP TABLE IF EXISTS workspaces CASCADE');
    await client.query('DROP TABLE IF EXISTS projects CASCADE');
    await client.query('DROP TABLE IF EXISTS api_keys CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');
    
    // Schema must match verify_runs.js / DevGuide
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
          last_active_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          idle_expires_at TIMESTAMP WITH TIME ZONE,
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

    CREATE TABLE IF NOT EXISTS evidence_bundles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id UUID NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        bundle_path TEXT,
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
    `;
    await client.query(schemaSql);
    console.log('Database reset and schema applied.');

    // 2. Create User
    console.log('--- creating user ---');
    const user = await createUser(client, 'streamer@example.com', 'Stream User');
    console.log(`User created: ${user.id}`);

    // 3. Create Project
    console.log('--- creating project ---');
    const project = await createProject(user.key, 'Stream Project', 'https://github.com/octocat/Hello-World.git');
    console.log(`Project created: ${project.projectId}`);

    // 4. Open Project
    console.log('--- opening project ---');
    await openProject(user.key, project.projectId);
    console.log('Project opened and workspace warm.');

    // 5. Run Streaming Message
    console.log('--- running streaming message ---');
    const prompt = 'echo "streaming test"';
    const events = await streamMessage(user.key, project.projectId, prompt);
    
    console.log('--- Stream Events Received ---');
    events.forEach(e => console.log(`[${e.type}]`, e.data));

    // Verify Events
    const runStart = events.find(e => e.type === 'run-start');
    const runComplete = events.find(e => e.type === 'run-complete');
    const tokens = events.filter(e => e.type === 'token');
    
    if (!runStart) throw new Error('Missing run-start event');
    if (!runComplete) throw new Error('Missing run-complete event');
    if (tokens.length === 0) throw new Error('No token events received');
    
    const runId = JSON.parse(runStart.data).runId;
    console.log(`Run ID from stream: ${runId}`);

    // Verify DB
    console.log('--- verifying run record in DB ---');
    const runRes = await client.query('SELECT * FROM runs WHERE id = $1', [runId]);
    if (runRes.rows.length === 0) throw new Error('Run not found in DB');
    
    const run = runRes.rows[0];
    console.log('DB Run:', run.status, run.final_text);
    
    if (run.status !== 'succeeded') throw new Error(`Run status is ${run.status}, expected succeeded`);
    if (run.prompt !== prompt) throw new Error('Prompt mismatch');
    
    // Verify tokens assembled match final text (approximately, depending on how we reconstruct)
    // The simulator splits by space, so let's see.
    // The worker "echo" command returns headers + output? No, just the output usually.
    // Let's just check that final_text is present.
    if (!run.final_text) throw new Error('final_text is missing in DB');

    // Verify runId and ts in all events
    events.forEach(e => {
        const data = JSON.parse(e.data);
        if (!data.runId) throw new Error(`Event ${e.type} missing runId`);
        if (!data.ts) throw new Error(`Event ${e.type} missing ts`);
        if (data.runId !== runId) throw new Error(`Event ${e.type} has mismatched runId`);
    });

    // Verify events file in container
    console.log('--- verifying events.jsonl in container ---');
    const workspaceRes = await client.query('SELECT container_id FROM workspaces WHERE project_id = $1', [project.projectId]);
    const containerId = workspaceRes.rows[0].container_id;
    
    const checkCmd = `docker exec ${containerId} cat /workspace/evidence/${runId}/events.jsonl`;
    await new Promise((resolve, reject) => {
        const proc = spawn('sh', ['-c', checkCmd]);
        let output = '';
        proc.stdout.on('data', d => output += d.toString());
        proc.stderr.on('data', d => console.error('docker stderr:', d.toString()));
        proc.on('close', code => {
            if (code !== 0) return reject(new Error(`Failed to cat events file. Exit code ${code}`));
            console.log('Events file content length:', output.length);
            if (output.length === 0) return reject(new Error('Events file is empty'));
            // Parse a line to verify
            try {
                const firstLine = JSON.parse(output.split('\n')[0]);
                if (firstLine.type !== 'run-start') return reject(new Error('First event in file is not run-start'));
                resolve();
            } catch (e) {
                reject(new Error('Failed to parse events file JSON'));
            }
        });
    });

    console.log('ALL STREAMING TESTS PASSED SUCCESSFULLY.');

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

function streamMessage(apiKey, projectId, text) {
    return new Promise((resolve, reject) => {
        const events = [];
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: `/projects/${projectId}/message/stream`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            }
        };

        const req = http.request(options, (res) => {
            if (res.statusCode !== 200) {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => reject(new Error(`Stream request failed: ${res.statusCode} ${body}`)));
                return;
            }

            let buffer = '';
            res.on('data', (chunk) => {
                process.stdout.write('.'); // Progress indicator
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                // Process all complete lines
                buffer = lines.pop(); // Keep the last incomplete line in the buffer

                let currentEvent = null;
                
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line === '') {
                        // End of event block
                        if (currentEvent) {
                            events.push(currentEvent);
                            currentEvent = null;
                        }
                    } else if (line.startsWith('event: ')) {
                        currentEvent = { type: line.replace('event: ', ''), data: null };
                    } else if (line.startsWith('data: ')) {
                        if (currentEvent) {
                            currentEvent.data = line.replace('data: ', '');
                        }
                    }
                }
            });

            res.on('end', () => {
                console.log('\nStream ended');
                resolve(events);
            });
            
            res.on('close', () => {
                console.log('\nStream closed');
            });
        });

        req.on('error', (e) => reject(e));
        req.write(JSON.stringify({ text }));
        req.end();
    });
}

main();