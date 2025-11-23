const { spawn } = require('child_process');
const crypto = require('crypto');

const API_URL = 'http://localhost:3000';
let adminToken = '';
let userId = '';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCommand(command, args, env = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { 
            env: { ...process.env, ...env },
            shell: true 
        });
        
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', (data) => stdout += data.toString());
        proc.stderr.on('data', (data) => stderr += data.toString());
        
        proc.on('close', (code) => {
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`Command failed with code ${code}: ${stderr}`));
        });
    });
}

async function createUser() {
    console.log('Creating user...');
    const output = await runCommand('node', ['scripts/create-user-and-key.js', `--email=obs_${Date.now()}@test.com`, '--name="Observability User"']);
    const lines = output.split('\n');
    userId = lines.find(l => l.startsWith('User ID:'))?.split(': ')[1]?.trim();
    adminToken = lines.find(l => l.startsWith('API Key:'))?.split(': ')[1]?.trim();
    
    if (!userId || !adminToken) {
        throw new Error(`Failed to create user. Output: ${output}`);
    }
    console.log(`User created: ${userId}`);
}

async function createProject() {
    console.log('Creating project...');
    const res = await fetch(`${API_URL}/projects`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': adminToken
        },
        body: JSON.stringify({
            name: 'Obs Project',
            repoUrl: 'https://github.com/octocat/Hello-World.git'
        })
    });
    
    if (!res.ok) throw new Error(`Failed to create project: ${res.statusText}`);
    const data = await res.json();
    return data.projectId;
}

async function openProject(projectId) {
    console.log('Opening project...');
    const res = await fetch(`${API_URL}/projects/${projectId}/open`, {
        method: 'POST',
        headers: { 'X-API-Key': adminToken }
    });
    
    if (!res.ok) throw new Error(`Failed to open project: ${res.statusText}`);
}

async function runMessage(projectId, text) {
    console.log('Sending message...');
    const res = await fetch(`${API_URL}/projects/${projectId}/message`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': adminToken
        },
        body: JSON.stringify({ text })
    });
    
    if (!res.ok) throw new Error(`Failed to send message: ${res.statusText}`);
    return await res.json();
}

async function runStreamingMessage(projectId, text) {
    console.log('Sending streaming message...');
    const res = await fetch(`${API_URL}/projects/${projectId}/message/stream`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': adminToken
        },
        body: JSON.stringify({ text })
    });
    
    if (!res.ok) throw new Error(`Failed to send streaming message: ${res.statusText}`);
    
    // Consume stream
    const reader = res.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
    }
}

async function getMetrics() {
    const res = await fetch(`${API_URL}/metrics`, {
        headers: { 'X-API-Key': adminToken }
    });
    if (!res.ok) throw new Error(`Failed to get metrics: ${res.statusText}`);
    return await res.json();
}

async function verify() {
    try {
        await createUser();
        const projectId = await createProject();
        await openProject(projectId);
        
        // 1. Initial Metrics
        console.log('Fetching initial metrics...');
        const initialMetrics = await getMetrics();
        console.log('Initial metrics:', JSON.stringify(initialMetrics, null, 2));

        // 2. Run Normal Message
        await runMessage(projectId, 'Hello World');
        
        // 3. Run Streaming Message
        await runStreamingMessage(projectId, 'Stream me');

        // 4. Trigger Quota Exceeded (Mocking or setting low limit via env if possible, 
        // but since we can't easily restart server with new env here without disruption,
        // we might check if we can simulate it. 
        // Actually, the easiest way to test quota metric increment is to MOCK the quota check or 
        // rely on the fact that we can't easily hit 500 requests. 
        // However, we can update the user-defined quota if that feature existed, but it's hardcoded to env or default.
        // Let's TRY to force it by setting the limit low in the process if we could, but we can't.
        // Alternative: Use a loop to exhaust quota? 500 is too many.
        // Let's assume for this test script we mainly verify the RUNS metrics first, 
        // and if we can't easily trigger quota, we might skip or use a separate test with specific env vars.)
        
        // Actually, let's just verify the RUNS metrics for now. 
        // Quota verification requires restarting server with RUNS_PER_DAY_LIMIT_DEFAULT=1 or similar.
        
        console.log('Fetching final metrics...');
        const finalMetrics = await getMetrics();
        console.log('Final metrics:', JSON.stringify(finalMetrics, null, 2));

        // Verify Normal Run Increment
        const runKey = 'arp_runs_total{status="success",streaming="false"}';
        const startRun = initialMetrics[runKey] || 0;
        const endRun = finalMetrics[runKey] || 0;
        
        if (endRun <= startRun) {
            throw new Error(`Metric ${runKey} did not increment! Start: ${startRun}, End: ${endRun}`);
        }
        console.log(`✅ ${runKey} incremented correctly.`);

        // Verify Streaming Run Increment
        const streamRunKey = 'arp_runs_total{status="success",streaming="true"}';
        const startStreamRun = initialMetrics[streamRunKey] || 0;
        const endStreamRun = finalMetrics[streamRunKey] || 0;
        
        if (endStreamRun <= startStreamRun) {
            throw new Error(`Metric ${streamRunKey} did not increment! Start: ${startStreamRun}, End: ${endStreamRun}`);
        }
        console.log(`✅ ${streamRunKey} incremented correctly.`);

        // Verify Streaming Total Increment
        const streamTotalKey = 'arp_streaming_runs_total';
        const startStreamTotal = initialMetrics[streamTotalKey] || 0;
        const endStreamTotal = finalMetrics[streamTotalKey] || 0;
        
        if (endStreamTotal <= startStreamTotal) {
             throw new Error(`Metric ${streamTotalKey} did not increment! Start: ${startStreamTotal}, End: ${endStreamTotal}`);
        }
        console.log(`✅ ${streamTotalKey} incremented correctly.`);

        console.log('All observability checks passed!');
        
    } catch (err) {
        console.error('Verification failed:', err);
        process.exit(1);
    }
}

verify();