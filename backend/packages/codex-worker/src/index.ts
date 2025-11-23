import Fastify from 'fastify';
import { Codex } from '@openai/codex-sdk';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger.js';

const execAsync = promisify(exec);
const fastify = Fastify({
    logger: false,
    genReqId: (req) => req.headers['x-request-id'] as string || 'unknown-req-id'
});

// Middleware to attach request ID and logger to request context
fastify.addHook('onRequest', (request, reply, done) => {
  request.log = logger.child({ requestId: request.id });
  done();
});

// Middleware to log response
fastify.addHook('onResponse', (request, reply, done) => {
    // Only log slow requests or errors if needed, or all for now
    // Worker logs prompt/diff separately, so maybe just minimal request log
    done();
});

// Global error handler
fastify.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, msg: 'Worker request failed' });
    reply.status(error.statusCode || 500).send({ error: error.message });
});

// Ideally we would fetch this from env or passed in, but for v0.1 simplified
// we will keep the thread in memory. Since the container is dedicated to one project/user session,
// persisting the thread in memory for the life of the container is acceptable per DevGuide.
let thread: any = null;

// Ensure we are in the correct directory for running git commands and codex
const REPO_PATH = '/workspace/repo';
const MOCK_MEMORY_FILE = path.join(REPO_PATH, '.mock_memory.json');

const apiKey = process.env.OPENAI_API_KEY;
const forceMock = process.env.FORCE_MOCK_CODEX === 'true';
const isMock = forceMock || !apiKey || apiKey === 'dummy-key' || apiKey.startsWith('sk-dummy');

const codex = isMock ? null : new Codex({ apiKey });

// Hardening: Command Whitelist
const ALLOWED_COMMANDS = [
  'npm test',
  'npm install', // Often needed before test
  'pytest',
  'ls',
  'cat',
  'git',
  'echo', // Useful for mocking/debug
  'pwd',
  // Add others as needed, but STRICTLY block risky ones
];

// Risky commands explicitly blocked (just in case regex matches partially)
const BLOCKED_COMMANDS = ['rm', 'curl', 'wget', 'chmod', 'chown', 'sudo'];

function isCommandAllowed(cmd: string): boolean {
    const trimmed = cmd.trim();
    // Check if starts with allowed command
    const allowed = ALLOWED_COMMANDS.some(ac => trimmed.startsWith(ac));
    if (!allowed) return false;

    // Check for blocked substrings or chained commands if simple whitelist isn't enough
    // For v0.1, strict prefix match + no chaining characters might be safest, but 'npm test' is complex.
    // Let's check if it contains dangerous characters for now?
    // Or just simple allowed list check.
    // We should also check if it STARTS with a blocked command (redundant if we only allow whitelist)
    // But we must prevent chaining like "ls && rm -rf /"
    
    if (trimmed.includes('&&') || trimmed.includes(';') || trimmed.includes('|')) {
        // Disallow chaining for security Hardening
        return false;
    }

    return true;
}

interface RunBody {
  text: string;
  runId: string;
}

// Helper to execute commands and log to evidence
async function runCommand(command: string, runId: string, ignoreError = false): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // If no runId, we might be in a legacy context or early init.
    // Fallback to simple execAsync or skip logging?
    // Requirement says "Worker must append...". We assume runId is always present for /run.
    
    const evidenceDir = `/workspace/evidence/${runId}`;
    const logFile = path.join(evidenceDir, 'command_log.jsonl');
    
    if (runId) {
        try {
            if (!fs.existsSync(evidenceDir)) {
                fs.mkdirSync(evidenceDir, { recursive: true });
            }
        } catch (e) {
            logger.error({ err: e }, 'Failed to create evidence directory');
        }
    }

    const ts = new Date().toISOString();
    const cwd = process.cwd();
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
        const result = await execAsync(command);
        stdout = result.stdout;
        stderr = result.stderr;
    } catch (e: any) {
        stdout = e.stdout || '';
        stderr = e.stderr || e.message;
        exitCode = e.code || 1;
    }

    if (runId) {
        const logEntry = {
            ts,
            type: 'command',
            command,
            cwd,
            exitCode,
            stdout: stdout.length > 8192 ? stdout.substring(0, 8192) + '...[TRUNCATED]' : stdout,
            stderr: stderr.length > 8192 ? stderr.substring(0, 8192) + '...[TRUNCATED]' : stderr
        };

        try {
            fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
        } catch (err) {
            logger.error({ err }, 'Failed to write to command_log.jsonl');
        }
    }

    if (exitCode !== 0 && !ignoreError) {
        const err = new Error(`Command failed: ${command}`);
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        (err as any).code = exitCode;
        throw err;
    }

    return { stdout, stderr, exitCode };
}

async function generateOutputsManifest(runId: string, gitCommit: string) {
    const evidenceDir = `/workspace/evidence/${runId}`;
    const outputFile = path.join(evidenceDir, 'outputs.json');
    
    let diffSummary = { filesChanged: 0, insertions: 0, deletions: 0 };
    try {
         // Use runCommand to log the stats gathering too
         const { stdout } = await runCommand('git diff --stat --cached', runId, true);
         
         // Parse: " 2 files changed, 4 insertions(+), 1 deletion(-)"
         const match = stdout.match(/(\d+) files? changed, (\d+) insertions?\(\+\), (\d+) deletions?\(-\)/);
         if (match) {
             diffSummary = {
                 filesChanged: parseInt(match[1] || '0'),
                 insertions: parseInt(match[2] || '0'),
                 deletions: parseInt(match[3] || '0')
             };
         }
    } catch (e) {
        logger.warn({err: e}, 'Failed to generate diff summary');
    }

    const manifest = {
        runId,
        createdAt: new Date().toISOString(),
        gitCommit,
        diffSummary,
        artifacts: []
    };

    try {
        fs.writeFileSync(outputFile, JSON.stringify(manifest, null, 2));
    } catch (e) {
         logger.error({err: e}, 'Failed to write outputs.json');
    }
}

function saveMockState(lastCreatedFile: string) {
    try {
        fs.writeFileSync(MOCK_MEMORY_FILE, JSON.stringify({ lastCreatedFile }));
    } catch (e) {
        logger.error({ err: e }, "Failed to save mock memory");
    }
}

function loadMockState(): string {
    try {
        if (fs.existsSync(MOCK_MEMORY_FILE)) {
            const data = fs.readFileSync(MOCK_MEMORY_FILE, 'utf8');
            return JSON.parse(data).lastCreatedFile || '';
        }
    } catch (e) {
        logger.error({ err: e }, "Failed to load mock memory");
    }
    return '';
}

async function getThread(existingId?: string) {
  if (isMock) {
    // Mock state to simulate memory
    // In a real scenario, threadId is used to fetch context from OpenAI.
    // In our mock, we use a file in the volume to persist "memory" across container restarts.
    let lastCreatedFile = loadMockState();

    return {
        id: existingId || 'mock-thread-' + Date.now(),
        run: async (text: string, runId?: string) => {
            // Simple mock logic for verifying persistence
            if (text.includes('lifecycle_test.txt')) {
                fs.writeFileSync('lifecycle_test.txt', 'Persistent Data');
                lastCreatedFile = 'lifecycle_test.txt';
                saveMockState(lastCreatedFile);
                return { text: 'Created lifecycle_test.txt' };
            }
            // Simple mock logic for verify.sh in Thrust 5 (codex_test.txt)
            if (text.includes('codex_test.txt')) {
                fs.writeFileSync('codex_test.txt', 'Hello Codex');
                lastCreatedFile = 'codex_test.txt';
                saveMockState(lastCreatedFile);
                return { text: 'Created codex_test.txt' };
            }
            // Logic for Thread Continuity test
            if (text.includes('continuity_test.txt')) {
                fs.writeFileSync('continuity_test.txt', 'Thread Memory');
                lastCreatedFile = 'continuity_test.txt';
                saveMockState(lastCreatedFile);
                return { text: 'Created continuity_test.txt' };
            }
            // Logic for Explicit Command Execution (Hardened)
            // This captures "run command: <cmd>" or similar intents
            const runCmdMatch = text.match(/run command:\s*(.+)/i) || text.match(/^run\s+(.+)/i);
            if (runCmdMatch) {
                const cmd = runCmdMatch[1].trim();
                
                // Special case for "run tests" which maps to npm test or test.sh
                if (cmd.toLowerCase() === 'tests' || cmd.toLowerCase() === 'test') {
                     try {
                         if (fs.existsSync('test.sh')) {
                             const { stdout, stderr } = await runCommand('bash test.sh', runId || '');
                             return { text: `Test Results:\n${stdout}\n${stderr}` };
                         }
                         if (fs.existsSync('package.json')) {
                             const { stdout, stderr } = await runCommand('npm test', runId || '');
                             return { text: `Test Results:\n${stdout}\n${stderr}` };
                         }
                         return { text: 'No test suite found.' };
                     } catch (e: any) {
                         return { text: `Test Execution Failed:\n${e.message}\n${e.stdout}\n${e.stderr}` };
                     }
                }

                if (!isCommandAllowed(cmd)) {
                     return { text: `Command rejected by security policy: ${cmd}` };
                }

                try {
                     const { stdout, stderr } = await runCommand(cmd, runId || '');
                     return { text: `Command Output:\n${stdout}\n${stderr}` };
                } catch (e: any) {
                     return { text: `Command Failed:\n${e.message}\n${e.stdout}\n${e.stderr}` };
                }
            }

            // Backward compatibility for "run tests" in text body without prefix
            if (text.toLowerCase().includes('run tests') || text.toLowerCase().includes('npm test')) {
                 try {
                     // This logic duplicates above but handles conversational "please run tests"
                     if (fs.existsSync('test.sh')) {
                         const { stdout, stderr } = await runCommand('bash test.sh', runId || '');
                         return { text: `Test Results:\n${stdout}\n${stderr}` };
                     }
                     if (fs.existsSync('package.json')) {
                         const { stdout, stderr } = await runCommand('npm test', runId || '');
                         return { text: `Test Results:\n${stdout}\n${stderr}` };
                     }
                     return { text: 'No test suite found (package.json or test.sh missing).' };
                } catch (e: any) {
                    return { text: `Test Execution Failed:\n${e.message}\n${e.stdout}\n${e.stderr}` };
                }
            }
             // Logic for creating test.sh (Helper for verification)
            if (text.includes('create test.sh')) {
                 fs.writeFileSync('test.sh', 'echo "TAP version 13"\necho "ok 1 - test passed"');
                 lastCreatedFile = 'test.sh';
                 saveMockState(lastCreatedFile);
                 return { text: 'Created test.sh' };
            }

            // Respond to "What file did you create?"
            if (text.toLowerCase().includes('what file did you create') || text.toLowerCase().includes('what file did you just create')) {
                if (lastCreatedFile) {
                     return { text: `I created ${lastCreatedFile}` };
                }
                return { text: 'I have not created any files yet.' };
            }

            return { text: 'Mock response' };
        }
    };
  }

  const options = {
    sandboxMode: 'workspace-write' as const,
  };

  if (existingId && codex) {
    try {
        // resumeThread might throw if invalid or expired, handle gracefully?
        // For v0.1 let's assume it works or we start new if needed (though sdk might just error)
        return await codex.resumeThread(existingId, options);
    } catch (e) {
        logger.warn({ err: e }, "Failed to resume thread, starting new one");
        return await codex.startThread(options);
    }
  }
  if (thread) return thread;
  return await codex!.startThread(options);
}

fastify.post<{ Body: RunBody }>('/run', async (request, reply) => {
  const { text, runId } = request.body;

  if (!text) {
    return reply.status(400).send({ error: 'Missing text in body' });
  }

  if (!runId) {
      // This might happen if Orchestrator isn't updated yet, or direct call.
      // We should probably warn but proceed for backward compat,
      // or fail if strict. Let's warn and use a placeholder to avoid crashing fs commands.
      request.log.warn('Missing runId in request body, evidence will be lost/misplaced');
  }
  const safeRunId = runId || 'unknown-run';

  try {
    // Ensure we are operating in the repo directory
    process.chdir(REPO_PATH);
  } catch (err) {
    request.log.error({ err }, `Failed to chdir to ${REPO_PATH}`);
  }
    
  try {
    // Capture git commit hash
    let gitCommit = '';
    try {
        const { stdout } = await runCommand('git rev-parse HEAD', safeRunId, true);
        gitCommit = stdout.trim();
    } catch (gitErr) {
        request.log.warn({ err: gitErr }, 'Failed to get git commit hash');
    }

    // Get or resume thread
    const envThreadId = process.env.CODEX_THREAD_ID;
    thread = await getThread(envThreadId || thread?.id);
    
    // Run Codex with timeout
    request.log.info({ msg: 'Running Codex', text });
    const start = Date.now();
    // Pass runId to thread.run if it supports it (Mock thread does)
    const runPromise = thread.run(text, safeRunId);
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Codex run timed out after 60 seconds')), 60000)
    );

    const result = await Promise.race([runPromise, timeoutPromise]) as any;
    const duration = Date.now() - start;
    const finalText = result.text || result.finalResponse || '';

    request.log.info({ msg: 'Thread execution result', result });

    // Compute diff
    // Stage changes to capture new files in diff
    await runCommand('git add -A', safeRunId);
    const { stdout: diff } = await runCommand('git diff --cached', safeRunId);

    // Generate outputs manifest
    await generateOutputsManifest(safeRunId, gitCommit);

    request.log.info({
        msg: 'Codex run completed',
        duration,
        diffSize: diff.length,
        diff: diff.length < 1000 ? diff : diff.substring(0, 1000) + '...'
    });

    return {
      finalText: finalText,
      diff: diff,
      threadId: thread.id,
      gitCommit: gitCommit
    };

  } catch (error) {
    request.log.error({ err: error }, 'Worker execution failed');
    return reply.status(500).send({ error: 'Internal Server Error', details: (error as Error).message });
  }
});

const start = async () => {
  try {
    await fastify.listen({ port: 7000, host: '0.0.0.0' });
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

start();