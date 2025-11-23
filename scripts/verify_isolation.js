const { Client } = require('pg');
const crypto = require('crypto');
const path = require('path');

// Load environment
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DB_URL = process.env.POSTGRES_URL || 'postgres://postgres:postgrespassword@localhost:5432/codexrt';
const ORCHESTRATOR_URL = 'http://localhost:3000';

async function main() {
  const client = new Client({ connectionString: DB_URL });
  
  try {
    console.log('--- connecting to db ---');
    await client.connect();

    // 1. Reset Database
    console.log('--- resetting database ---');
    await client.query('DROP TABLE IF EXISTS workspaces CASCADE');
    await client.query('DROP TABLE IF EXISTS projects CASCADE');
    await client.query('DROP TABLE IF EXISTS api_keys CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');
    
    // Read schema file content directly or just execute the SQL strings we know
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
          state TEXT NOT NULL, -- warm, cold, error
          container_id TEXT,
          volume_name TEXT NOT NULL,
          thread_id TEXT,
          last_active_at TIMESTAMP DEFAULT NOW(),
          idle_expires_at TIMESTAMP,
          image_name TEXT,
          image_digest TEXT,
          runtime_metadata JSONB
      );
    `;
    await client.query(schemaSql);
    console.log('Database reset and schema applied.');

    // 2. Create Users
    console.log('--- creating users ---');
    const userA = await createUser(client, 'usera@example.com', 'User A');
    const userB = await createUser(client, 'userb@example.com', 'User B');
    console.log(`User A: ${userA.id}, Key: ${userA.key}`);
    console.log(`User B: ${userB.id}, Key: ${userB.key}`);

    // 3. User A Creates Project A1
    console.log('--- User A creating Project A1 ---');
    const projectA1 = await createProject(userA.key, 'Project A1', 'https://github.com/octocat/Hello-World.git');
    console.log(`Project A1 created: ${projectA1.projectId}`);

    // 4. User B Creates Project B1
    console.log('--- User B creating Project B1 ---');
    const projectB1 = await createProject(userB.key, 'Project B1', 'https://github.com/octocat/Spoon-Knife.git');
    console.log(`Project B1 created: ${projectB1.projectId}`);

    // 5. Verify Isolation: User A should not see Project B1
    console.log('--- Verifying Isolation (List Projects) ---');
    const projectsA = await listProjects(userA.key);
    console.log(`User A Projects: ${projectsA.map(p => p.name).join(', ')}`);
    if (projectsA.find(p => p.id === projectB1.projectId)) {
      throw new Error('User A can see Project B1! FAIL');
    }
    if (!projectsA.find(p => p.id === projectA1.projectId)) {
      throw new Error('User A cannot see Project A1! FAIL');
    }
    console.log('Isolation passed: User A sees only their projects.');

    // 6. Verify Access Control: User A cannot open Project B1
    console.log('--- Verifying Access Control (Open Project) ---');
    try {
        await openProject(userA.key, projectB1.projectId);
        throw new Error('User A was able to open Project B1! FAIL');
    } catch (e) {
        if (e.status === 404) {
            console.log('Access Control passed: User A got 404 for Project B1.');
        } else {
            throw e;
        }
    }

    // 7. Verify Warm Workspace Limit (Per User)
    // User A opens A1 -> Warm
    console.log('--- User A opening Project A1 ---');
    await openProject(userA.key, projectA1.projectId);
    
    // User B opens B1 -> Warm
    console.log('--- User B opening Project B1 ---');
    await openProject(userB.key, projectB1.projectId);
    
    // Check DB states
    let wsA1 = await getWorkspaceState(client, projectA1.projectId);
    let wsB1 = await getWorkspaceState(client, projectB1.projectId);
    
    console.log(`A1 State: ${wsA1}, B1 State: ${wsB1}`);
    if (wsA1 !== 'warm' || wsB1 !== 'warm') {
        throw new Error('Both workspaces should be warm! FAIL');
    }
    console.log('Per-user warm limit passed: A1 and B1 are both warm.');

    // 8. Verify LRU Eviction (Per User)
    // User A creates and opens Project A2
    console.log('--- User A creating and opening Project A2 ---');
    const projectA2 = await createProject(userA.key, 'Project A2', 'https://github.com/octocat/Hello-World.git');
    await openProject(userA.key, projectA2.projectId);
    
    // Check DB states
    wsA1 = await getWorkspaceState(client, projectA1.projectId);
    const wsA2 = await getWorkspaceState(client, projectA2.projectId);
    wsB1 = await getWorkspaceState(client, projectB1.projectId);
    
    console.log(`A1 State: ${wsA1}, A2 State: ${wsA2}, B1 State: ${wsB1}`);
    
    if (wsA1 !== 'cold') {
        throw new Error('Project A1 should have gone cold! FAIL');
    }
    if (wsA2 !== 'warm') {
        throw new Error('Project A2 should be warm! FAIL');
    }
    if (wsB1 !== 'warm') {
        throw new Error('Project B1 should still be warm! FAIL');
    }
    
    console.log('LRU Eviction passed: A1 cold, A2 warm, B1 warm.');

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

async function listProjects(apiKey) {
    const res = await fetch(`${ORCHESTRATOR_URL}/projects`, {
        method: 'GET',
        headers: { 'x-api-key': apiKey }
    });
    if (!res.ok) throw new Error(`List Projects failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.projects;
}

async function openProject(apiKey, projectId) {
    const res = await fetch(`${ORCHESTRATOR_URL}/projects/${projectId}/open`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey }
    });
    if (!res.ok) {
        const err = new Error(`Open Project failed: ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return await res.json();
}

async function getWorkspaceState(client, projectId) {
    const res = await client.query(
        'SELECT state FROM workspaces WHERE project_id = $1',
        [projectId]
    );
    return res.rows[0]?.state || 'unknown';
}

main();