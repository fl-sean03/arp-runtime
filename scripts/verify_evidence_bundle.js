const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const { Client } = require('pg');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const execAsync = util.promisify(exec);

const BASE_URL = 'http://localhost:3000';
const DB_URL = process.env.POSTGRES_URL || 'postgres://postgres:postgrespassword@localhost:5432/codexrt';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

async function main() {
    const client = new Client({ connectionString: DB_URL });
    try {
        await client.connect();
        console.log('Starting verification of Evidence Bundles...');
        
        const user = await createUser(client, `evidence-${Date.now()}@example.com`, 'Evidence User');
        console.log(`Created user with key: ${user.key}`);
        
        const HEADERS = {
            'x-api-key': user.key,
            'Content-Type': 'application/json'
        };

        // 1. Create Project
        console.log('Creating project...');
        const createRes = await fetch(`${BASE_URL}/projects`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({
                name: 'Evidence Test Project',
                repoUrl: 'https://github.com/octocat/Hello-World.git'
            })
        });
        
        if (!createRes.ok) {
            throw new Error(`Failed to create project: ${createRes.status} ${await createRes.text()}`);
        }
        const { projectId } = await createRes.json();
        console.log(`Project created: ${projectId}`);

        // 2. Open Project (Warm up)
        console.log('Opening project...');
        const openRes = await fetch(`${BASE_URL}/projects/${projectId}/open`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({})
        });
        if (!openRes.ok) {
            throw new Error(`Failed to open project: ${openRes.status} ${await openRes.text()}`);
        }
        const { workspaceId } = await openRes.json();
        console.log(`Workspace opened: ${workspaceId}`);

        // 3. Send Message (Trigger Run)
        console.log('Sending message...');
        const msgRes = await fetch(`${BASE_URL}/projects/${projectId}/message`, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({
                text: 'List files in current directory'
            })
        });
        
        if (!msgRes.ok) {
            throw new Error(`Failed to send message: ${msgRes.status} ${await msgRes.text()}`);
        }
        const { runId } = await msgRes.json();
        console.log(`Run completed: ${runId}`);

        // 4. Poll Evidence Endpoint
        console.log('Polling evidence endpoint...');
        let evidenceRes;
        let retries = 10;
        
        while (retries > 0) {
            evidenceRes = await fetch(`${BASE_URL}/runs/${runId}/evidence`, {
                method: 'GET',
                headers: HEADERS
            });

            if (evidenceRes.status === 200) {
                console.log('Evidence bundle ready!');
                break;
            } else if (evidenceRes.status === 202) {
                console.log('Evidence bundle pending...');
            } else if (evidenceRes.status === 404) {
                 console.log('Evidence bundle not found yet...');
            } else {
                const text = await evidenceRes.text();
                console.log(`Error fetching evidence: ${evidenceRes.status} ${text}`);
                // if 500, maybe fatal
                if (evidenceRes.status === 500) retries = 0;
            }

            await sleep(2000);
            retries--;
        }

        if (!evidenceRes || evidenceRes.status !== 200) {
            throw new Error('Failed to retrieve evidence bundle within timeout');
        }

        // 5. Download and Verify
        const zipBuffer = await evidenceRes.arrayBuffer();
        const zipPath = path.resolve(__dirname, 'test_evidence.zip');
        fs.writeFileSync(zipPath, Buffer.from(zipBuffer));
        console.log(`Evidence bundle saved to ${zipPath}`);

        // Unzip and inspect
        const extractPath = path.resolve(__dirname, 'test_evidence_extract');
        if (fs.existsSync(extractPath)) fs.rmSync(extractPath, { recursive: true });
        fs.mkdirSync(extractPath);

        await execAsync(`unzip ${zipPath} -d ${extractPath}`);
        console.log('Unzipped bundle.');

        // Check contents
        // The zip structure should be <runId>/metadata.json etc.
        const runDir = path.join(extractPath, runId);
        if (!fs.existsSync(runDir)) {
             // check if files are at root if my zipping logic was flat
             const filesAtRoot = fs.readdirSync(extractPath);
             console.log('Files extracted:', filesAtRoot);
             if (fs.existsSync(path.join(extractPath, 'metadata.json'))) {
                 console.warn('Warning: Files are at root of zip, expected nested folder');
             } else {
                 throw new Error(`Expected directory ${runId} in zip not found`);
             }
        } else {
             console.log(`Found run directory: ${runDir}`);
             const files = fs.readdirSync(runDir);
             console.log('Files in bundle:', files);

             const requiredFiles = ['metadata.json', 'env_snapshot.json', 'events.jsonl'];
             for (const f of requiredFiles) {
                 if (!files.includes(f)) throw new Error(`Missing required file: ${f}`);
             }
             console.log('Required files present.');
        }

        console.log('Verification Successful!');
        
    } catch (error) {
        console.error('Verification Failed:', error);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main();