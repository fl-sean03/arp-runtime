import Fastify from 'fastify';
import { createDb, CodexEvent } from '@codex/shared';
import { WorkspaceManager } from '@codex/workspace-manager';
import * as dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';
import { startIdleReaper } from './background/idle-reaper';
import { startGCWorker, runWorkspaceGC, runEvidenceGC } from './background/gc-worker';
import { LockManager } from './lib/lock-manager';
import { checkQuota } from './lib/quota';
import { logger } from './logger';
import { metrics } from './metrics';
import { randomUUID } from 'crypto';
import { authCheck } from './plugins/auth';
import { EvidenceBuilder } from './background/evidence-builder';
import fs from 'fs';

// Load environment variables from root .env
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const fastify = Fastify({
  logger: false, // Disable default logger to use custom pino instance
  genReqId: () => randomUUID()
});

// Middleware to attach request ID and logger to request context
fastify.addHook('onRequest', (request, reply, done) => {
  request.log = logger.child({ requestId: request.id });
  logger.info({
    msg: 'Incoming request',
    method: request.method,
    url: request.url,
    requestId: request.id
  });
  done();
});

// Middleware to log response
fastify.addHook('onResponse', (request, reply, done) => {
    logger.info({
        msg: 'Request completed',
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        requestId: request.id,
        duration: reply.getResponseTime()
    });
    done();
});

// Global error handler
fastify.setErrorHandler((error, request, reply) => {
    metrics.increment('errors');
    request.log.error({ err: error, msg: 'Request failed' });
    reply.status(error.statusCode || 500).send({ error: error.message });
});

const db = createDb(process.env.POSTGRES_URL || 'postgres://user:pass@localhost:5432/db_name');
const workspaceManager = new WorkspaceManager();
const lockManager = new LockManager();
const evidenceBuilder = new EvidenceBuilder(db, workspaceManager);

// Helper to trigger evidence build
const triggerEvidenceBuild = async (runId: string, userId: string, projectId: string, workspaceId: string) => {
  try {
    await db.insertInto('evidence_bundles')
      .values({
        run_id: runId,
        user_id: userId,
        project_id: projectId,
        workspace_id: workspaceId,
        status: 'pending'
      })
      .onConflict((oc) => oc.column('run_id').doNothing())
      .execute();

    // Fire and forget
    evidenceBuilder.buildBundle(runId).catch(err => {
      logger.error({ err, runId }, 'Background evidence build failed');
    });
  } catch (error) {
    logger.error({ error, runId }, 'Failed to trigger evidence build');
  }
};

// Start the background job
startIdleReaper(db, workspaceManager);
startGCWorker(db, workspaceManager);

// Public health check
fastify.get('/healthz', async () => {
  return { ok: true };
});

// Protected Routes
fastify.register(async (protectedRoutes) => {
  protectedRoutes.addHook('onRequest', async (request, reply) => {
      await authCheck(request, reply, db);
  });

  // Metrics endpoint
  protectedRoutes.get('/metrics', async (request, reply) => {
      return metrics.getMetrics();
  });

  // Trigger GC manually (Ops/Dev endpoint)
  protectedRoutes.post('/ops/gc', async (request, reply) => {
      request.log.info('Manual GC trigger requested');
      try {
          await runWorkspaceGC(db, workspaceManager);
          await runEvidenceGC(db);
          return { status: 'ok', msg: 'GC triggered' };
      } catch (err) {
          request.log.error({ err }, 'Manual GC failed');
          return reply.status(500).send({ error: 'GC failed' });
      }
  });

  // Schema for POST /projects
  const createProjectSchema = z.object({
    name: z.string(),
    repoUrl: z.string().url(),
  });

  // GET /projects - List user's projects
  protectedRoutes.get('/projects', async (request, reply) => {
    try {
      const projects = await db
        .selectFrom('projects')
        .selectAll()
        .where('user_id', '=', request.user.id)
        .orderBy('created_at', 'desc')
        .execute();

      return { projects };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: 'Failed to list projects' });
    }
  });

  protectedRoutes.post('/projects', async (request, reply) => {
    const result = createProjectSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    const { name, repoUrl } = result.data;

    try {
      const project = await db
        .insertInto('projects')
        .values({
          name,
          repo_url: repoUrl,
          user_id: request.user.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return { projectId: project.id };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: 'Failed to create project' });
    }
  });

  protectedRoutes.post('/projects/:id/open', async (request, reply) => {
    const { id } = request.params as { id: string };
    
    try {
      // 0. Fetch project details (scoped to user)
      const project = await db
        .selectFrom('projects')
        .select('repo_url')
        .where('id', '=', id)
        .where('user_id', '=', request.user.id)
        .executeTakeFirst();

      if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      // 1. Check if workspace exists (scoped to user)
      let workspace = await db
        .selectFrom('workspaces')
        .select(['id', 'state', 'thread_id', 'container_id', 'volume_name'])
        .where('project_id', '=', id)
        .where('user_id', '=', request.user.id)
        .executeTakeFirst();

      // 1.5 LRU Stop: Stop other warm workspaces (One Warm Workspace Rule PER USER)
      const otherWarmWorkspaces = await db
        .selectFrom('workspaces')
        .select(['id', 'container_id'])
        .where('state', '=', 'warm')
        .where('project_id', '!=', id) // Don't stop the one we are trying to open if it's already warm
        .where('user_id', '=', request.user.id) // Only stop THIS user's workspaces
        .execute();

      if (otherWarmWorkspaces.length > 0) {
        request.log.info(`Stopping ${otherWarmWorkspaces.length} other warm workspaces for user ${request.user.id}...`);
        for (const other of otherWarmWorkspaces) {
          if (other.container_id) {
            try {
              await workspaceManager.stopWorkspace(other.container_id);
            } catch (err) {
              request.log.warn({ err, containerId: other.container_id, workspaceId: other.id }, `Failed to stop container`);
            }
          }
          // Mark as cold
          await db
            .updateTable('workspaces')
            .set({ state: 'cold', container_id: null })
            .where('id', '=', other.id)
            .execute();
        }
      }

      const apiKey = process.env.OPENAI_API_KEY || 'dummy-key';
      const envVars: Record<string, string> = {};

      // Propagate FORCE_MOCK_CODEX if set
      if (process.env.FORCE_MOCK_CODEX) {
          envVars['FORCE_MOCK_CODEX'] = process.env.FORCE_MOCK_CODEX;
      }

      // If it's warm, we don't need to do anything (unless we want to refresh TTL)
      if (workspace && workspace.state === 'warm' && workspace.container_id) {
        return { workspaceId: workspace.id, state: 'warm' };
      }

      // If it's cold, we resume (or create if it didn't exist)
      // Check for thread_id to restore
      if (workspace && workspace.thread_id) {
        envVars['CODEX_THREAD_ID'] = workspace.thread_id;
        metrics.increment('cold_resumes');
        request.log.info({ threadId: workspace.thread_id }, `Resuming cold workspace for project ${id}`);
      } else {
        metrics.increment('cold_resumes'); // Count as cold resume/start even if no thread
      }

      // 2. Create warm workspace container
      const { containerId, volumeName, imageName, imageDigest } = await workspaceManager.createWarmWorkspace(id, project.repo_url, apiKey, envVars);

      // 3. Upsert workspace record
      if (workspace) {
         // Update existing record to warm
         const updated = await db
           .updateTable('workspaces')
           .set({
             state: 'warm',
             container_id: containerId,
             image_name: imageName,
             image_digest: imageDigest,
             idle_expires_at: new Date(Date.now() + 20 * 60 * 1000), // Reset TTL
             last_active_at: new Date()
           })
           .where('id', '=', workspace.id)
           .returning('id')
           .executeTakeFirstOrThrow();
         workspace = { ...workspace, id: updated.id };
      } else {
         // Insert new
         const inserted = await db
           .insertInto('workspaces')
           .values({
             project_id: id,
             user_id: request.user.id,
             state: 'warm',
             container_id: containerId,
             volume_name: volumeName,
             image_name: imageName,
             image_digest: imageDigest,
             thread_id: null,
             idle_expires_at: new Date(Date.now() + 20 * 60 * 1000)
           })
           .returning('id')
           .executeTakeFirstOrThrow();
         workspace = { ...inserted, state: 'warm', thread_id: null, container_id: containerId, volume_name: volumeName };
      }

      return { workspaceId: workspace.id, state: 'warm' };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: 'Failed to open workspace' });
    }
  });

  protectedRoutes.post('/projects/:id/message', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { text } = request.body as { text: string };

    // Check quota
    const allowed = await checkQuota(db, request.user.id);
    if (!allowed) {
      metrics.increment('arp_quota_exceeded_total', { user_id: request.user.id });
      return reply.code(429).send({ error: 'quota_exceeded' });
    }

    // Wrap in lock manager to serialize requests per project
    try {
      return await lockManager.run(id, async () => {
        // 1. Find warm workspace (scoped to user)
        const workspace = await db
          .selectFrom('workspaces')
          .select(['id', 'container_id', 'state', 'thread_id', 'image_name', 'image_digest', 'runtime_metadata'])
          .where('project_id', '=', id)
          .where('user_id', '=', request.user.id)
          .where('state', '=', 'warm')
          .executeTakeFirst();

        if (!workspace || !workspace.container_id) {
          throw { status: 409, message: 'No warm workspace found. Open project first.' };
        }

        // 2. Create Run Record (running)
        const startTime = Date.now();
        const run = await db
          .insertInto('runs')
          .values({
            user_id: request.user.id,
            project_id: id,
            workspace_id: workspace.id,
            status: 'running',
            prompt: text,
            started_at: new Date(startTime),
            image_name: workspace.image_name,
            image_digest: workspace.image_digest,
            env_snapshot: workspace.runtime_metadata
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        // 3. Get container IP and prepare worker URL
        const ip = await workspaceManager.getContainerIp(workspace.container_id);
        const workerUrl = `http://${ip}:7000/run`;

        try {
          // 4. Call worker
          const response = await fetch(workerUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-request-id': request.id // Propagate request ID
            },
            body: JSON.stringify({ text, runId: run.id })
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Worker responded with ${response.status}: ${errText}`);
          }

          const result = (await response.json()) as { finalText: string; diff: string; threadId: string; gitCommit?: string };
          request.log.info({ msg: 'Worker response', result });
          const finishedAt = new Date();
          const duration = Date.now() - startTime;

          // Generate events log
          const events: CodexEvent[] = [];
          events.push({
             type: 'run-start',
             ts: new Date(startTime).toISOString(),
             runId: run.id
          });
          if (result.finalText) {
             events.push({
                type: 'token',
                ts: new Date(startTime + duration / 2).toISOString(), // approximate
                runId: run.id,
                delta: result.finalText,
                sequence: 0
             });
          }
          if (result.diff) {
             events.push({
                type: 'diff',
                ts: new Date(finishedAt).toISOString(),
                runId: run.id,
                diff: result.diff
             });
          }
          events.push({
             type: 'run-complete',
             ts: finishedAt.toISOString(),
             runId: run.id,
             status: 'succeeded'
          });

          try {
              const eventsNdjson = events.map(e => JSON.stringify(e)).join('\n');
              await workspaceManager.putFile(workspace.container_id!, `/workspace/evidence/${run.id}/events.jsonl`, eventsNdjson);
          } catch (err) {
              request.log.error({ err }, 'Failed to write events.jsonl (non-streaming)');
          }

          // 5. Update Run Record (succeeded)
          // Merge evidence info into env_snapshot (assuming worker created them)
          const evidenceInfo = {
              evidencePath: `/workspace/evidence/${run.id}`,
              hasCommandLog: true,
              hasOutputsManifest: true
          };
          const newSnapshot = {
              ...(workspace.runtime_metadata as object || {}),
              ...evidenceInfo
          };

          await db
            .updateTable('runs')
            .set({
              status: 'succeeded',
              final_text: result.finalText,
              diff: result.diff,
              git_commit: result.gitCommit,
              finished_at: finishedAt,
              duration_ms: duration,
              env_snapshot: newSnapshot
            })
            .where('id', '=', run.id)
            .execute();

          // 6. Update workspace activity
          const idleMinutes = parseFloat(process.env.WARM_IDLE_MINUTES || '20');
          const idleExpiresAt = new Date(Date.now() + idleMinutes * 60 * 1000);
          
          await db
            .updateTable('workspaces')
            .set({
              thread_id: result.threadId,
              last_active_at: new Date(),
              idle_expires_at: idleExpiresAt
            })
            .where('id', '=', workspace.id)
            .execute();
          
          metrics.increment('arp_runs_total', { status: 'success', streaming: false });
          request.log.info({
              msg: 'Run completed',
              userId: request.user.id,
              runId: run.id,
              streaming: false
          });

          // 7. Trigger Evidence Build
          await triggerEvidenceBuild(run.id, request.user.id, id, workspace.id);

          // 8. Return result
          return {
            runId: run.id,
            finalText: result.finalText,
            diff: result.diff
          };

        } catch (workerError: any) {
          // Handle worker failure or timeout
          const finishedAt = new Date();
          const duration = Date.now() - startTime;
          
          await db
            .updateTable('runs')
            .set({
              status: 'failed',
              error_message: workerError.message,
              finished_at: finishedAt,
              duration_ms: duration
            })
            .where('id', '=', run.id)
            .execute();

          // Generate failure events
          try {
            const events: CodexEvent[] = [
                { type: 'run-start', ts: new Date(startTime).toISOString(), runId: run.id },
                { type: 'run-complete', ts: finishedAt.toISOString(), runId: run.id, status: 'failed', error: workerError.message }
            ];
            const eventsNdjson = events.map(e => JSON.stringify(e)).join('\n');
            await workspaceManager.putFile(workspace.container_id!, `/workspace/evidence/${run.id}/events.jsonl`, eventsNdjson);
          } catch (err) {
             request.log.error({ err }, 'Failed to write events.jsonl on failure (non-streaming)');
          }

          // Trigger evidence build even on failure (to capture logs)
          await triggerEvidenceBuild(run.id, request.user.id, id, workspace.id);
            
          throw workerError;
        }
      });
    } catch (error: any) {
      if (error.status === 409) {
          return reply.status(409).send({ error: error.message });
      }
      request.log.error(error);
      return reply.status(500).send({ error: 'Failed to process message' });
    }
  });

  // POST /projects/:id/message/stream
  protectedRoutes.post('/projects/:id/message/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { text } = request.body as { text: string };

    // Check quota
    const allowed = await checkQuota(db, request.user.id);
    if (!allowed) {
      metrics.increment('arp_quota_exceeded_total', { user_id: request.user.id });
      return reply.code(429).send({ error: 'quota_exceeded' });
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    // ... rest of stream handler (implicit)

    const runEvents: CodexEvent[] = [];
    // Helper will be defined after runId is available
    let sendEvent: (event: CodexEvent) => void = () => {};

    // Wrap in lock manager to serialize requests per project
    try {
      await lockManager.run(id, async () => {
        // 1. Find warm workspace (scoped to user)
        const workspace = await db
          .selectFrom('workspaces')
          .select(['id', 'container_id', 'state', 'thread_id', 'image_name', 'image_digest', 'runtime_metadata'])
          .where('project_id', '=', id)
          .where('user_id', '=', request.user.id)
          .where('state', '=', 'warm')
          .executeTakeFirst();

        if (!workspace || !workspace.container_id) {
          throw { status: 409, message: 'No warm workspace found. Open project first.' };
        }

        // 2. Create Run Record (running)
        const startTime = Date.now();
        const run = await db
          .insertInto('runs')
          .values({
            user_id: request.user.id,
            project_id: id,
            workspace_id: workspace.id,
            status: 'running',
            prompt: text,
            started_at: new Date(startTime),
            image_name: workspace.image_name,
            image_digest: workspace.image_digest,
            env_snapshot: workspace.runtime_metadata
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        sendEvent = (event: CodexEvent) => {
            runEvents.push(event);
            reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };

        const emit = (partial: any) => {
            const event = {
                ...partial,
                ts: new Date().toISOString(),
                runId: run.id
            } as CodexEvent;
            sendEvent(event);
        };

        // Emit run-start
        emit({ type: 'run-start' });

        // 3. Get container IP and prepare worker URL
        let workerUrl: string;
        // Detect if running locally (not in the same docker network as worker)
        // We use POSTGRES_URL as a heuristic: if DB is localhost, we are local.
        const pgUrl = process.env.POSTGRES_URL || '';
        const isLocal = pgUrl.includes('localhost') || pgUrl.includes('127.0.0.1') || process.env.USE_LOCALHOST_WORKER === 'true';
        
        if (isLocal) {
            const port = await workspaceManager.getContainerHostPort(workspace.container_id, 7000);
            workerUrl = `http://127.0.0.1:${port}/run`;
            request.log.info({ msg: 'Detected local execution', port, workerUrl, pgUrl });
        } else {
            const ip = await workspaceManager.getContainerIp(workspace.container_id);
            workerUrl = `http://${ip}:7000/run`;
            request.log.info({ msg: 'Detected container execution', ip, workerUrl });
        }

        try {
          // 4. Call worker (simulated streaming for now)
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

          let response;
          try {
            // Retry logic for worker connection
            for (let i = 0; i < 15; i++) {
                try {
                    response = await fetch(workerUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-request-id': request.id
                        },
                        body: JSON.stringify({ text, runId: run.id }),
                        signal: controller.signal
                    });
                    break;
                } catch (e: any) {
                    if (i === 14) throw e;
                    if (e.name === 'AbortError') throw e;
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
          } finally {
            clearTimeout(timeout);
          }
          
          if (!response) throw new Error('Failed to connect to worker');

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Worker responded with ${response.status}: ${errText}`);
          }

          const result = (await response.json()) as { finalText: string; diff: string; threadId: string; gitCommit?: string };
          request.log.info({ msg: 'Worker response', result });

          // Simulate token streaming
          // Split by space or simple chunking to simulate tokens
          // Note: OpenAI Codex response is text, but we want to simulate "typing"
          const tokens = result.finalText.split(/(\s+)/); // Split by whitespace but keep delimiters
          
          for (let i = 0; i < tokens.length; i++) {
              const token = tokens[i];
              if (token.length > 0) {
                  emit({ type: 'token', delta: token, sequence: i });
                  // Add small delay to simulate generation time (10-50ms)
                  await new Promise(r => setTimeout(r, 20));
              }
          }

          const finishedAt = new Date();
          const duration = Date.now() - startTime;

          // Emit diff if present
          if (result.diff) {
              emit({ type: 'diff', diff: result.diff });
          }

          // 5. Update Run Record (succeeded)
          const evidenceInfo = {
              evidencePath: `/workspace/evidence/${run.id}`,
              hasCommandLog: true,
              hasOutputsManifest: true
          };
          const newSnapshot = {
              ...(workspace.runtime_metadata as object || {}),
              ...evidenceInfo
          };

          await db
            .updateTable('runs')
            .set({
              status: 'succeeded',
              final_text: result.finalText,
              diff: result.diff,
              git_commit: result.gitCommit,
              env_snapshot: newSnapshot,
              finished_at: finishedAt,
              duration_ms: duration
            })
            .where('id', '=', run.id)
            .execute();

          // 6. Update workspace activity
          const idleMinutes = parseFloat(process.env.WARM_IDLE_MINUTES || '20');
          const idleExpiresAt = new Date(Date.now() + idleMinutes * 60 * 1000);
          
          await db
            .updateTable('workspaces')
            .set({
              thread_id: result.threadId,
              last_active_at: new Date(),
              idle_expires_at: idleExpiresAt
            })
            .where('id', '=', workspace.id)
            .execute();

          metrics.increment('arp_runs_total', { status: 'success', streaming: true });
          metrics.increment('arp_streaming_runs_total');
          request.log.info({
              msg: 'Run completed (stream)',
              userId: request.user.id,
              runId: run.id,
              streaming: true
          });
          
          // Write events log
          try {
             const eventsNdjson = runEvents.map(e => JSON.stringify(e)).join('\n');
             request.log.info('Starting putFile for events.jsonl');
             await workspaceManager.putFile(workspace.container_id!, `/workspace/evidence/${run.id}/events.jsonl`, eventsNdjson);
             request.log.info('Finished putFile for events.jsonl');
          } catch (err) {
             request.log.error({ err }, 'Failed to write events.jsonl');
          }

          // Trigger Evidence Build (AFTER events are written)
          await triggerEvidenceBuild(run.id, request.user.id, id, workspace.id);

          // Emit run-complete
          emit({ type: 'run-complete', status: 'succeeded' });

        } catch (workerError: any) {
          // Handle worker failure or timeout
          const finishedAt = new Date();
          const duration = Date.now() - startTime;
          
          await db
            .updateTable('runs')
            .set({
              status: 'failed',
              error_message: workerError.message,
              finished_at: finishedAt,
              duration_ms: duration
            })
            .where('id', '=', run.id)
            .execute();
            
          // Write events log even on failure
          try {
             const eventsNdjson = runEvents.map(e => JSON.stringify(e)).join('\n');
             await workspaceManager.putFile(workspace.container_id!, `/workspace/evidence/${run.id}/events.jsonl`, eventsNdjson);
          } catch (err) {
             request.log.error({ err }, 'Failed to write events.jsonl on failure');
          }

          // Trigger evidence build (AFTER events are written)
          await triggerEvidenceBuild(run.id, request.user.id, id, workspace.id);

          emit({ type: 'run-complete', status: 'failed', error: workerError.message });

          // Don't throw here, just log, since we already sent the error to client via SSE
          request.log.error(workerError);
        }
      });
    } catch (error: any) {
        // Errors from outside the worker call (e.g. lock manager, DB, or initial checks)
        // If headers not sent yet (rare if we set them at top), we could send JSON error.
        // But we already set headers. So we must send SSE error if possible.
        // However, if it's 409 (Lock/Workspace), we might want to just close stream with error.
        
        // For simplicity, if we are here, we probably haven't started the run properly or failed early.
        // If runId exists (unlikely if failed at step 1), we should have handled it inside.
        
        // Just send a run-complete with failure if possible
        try {
            // If we have a runId (unlikely if failed early), try to use it. Otherwise send dummy runId or just raw.
            // Since sendEvent expects CodexEvent, we construct one manually.
             const event = {
                type: 'run-complete',
                status: 'failed',
                error: error.message,
                ts: new Date().toISOString(),
                runId: 'unknown'
            } as CodexEvent;
            sendEvent(event);
        } catch (e) {
            // Socket might be closed
        }
        request.log.error(error);
    } finally {
        reply.raw.end();
    }
  });

  // GET /projects/:id/runs - List runs for a project
  protectedRoutes.get('/projects/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    
    // Check if project belongs to user
    const project = await db
      .selectFrom('projects')
      .select('id')
      .where('id', '=', id)
      .where('user_id', '=', request.user.id)
      .executeTakeFirst();

    if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
    }

    try {
        const runs = await db
            .selectFrom('runs')
            .select(['id', 'status', 'prompt', 'started_at', 'finished_at', 'duration_ms'])
            .where('project_id', '=', id)
            .orderBy('started_at', 'desc')
            .limit(50) // Simple pagination limit for now
            .execute();
            
        return { runs };
    } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch runs' });
    }
  });

  // GET /runs/:id - Get specific run details
  protectedRoutes.get('/runs/:id', async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
          const run = await db
              .selectFrom('runs')
              .selectAll()
              .where('id', '=', id)
              .where('user_id', '=', request.user.id) // Scope to user
              .executeTakeFirst();

          if (!run) {
              return reply.status(404).send({ error: 'Run not found' });
          }

          return { run };
      } catch (error) {
          request.log.error(error);
          return reply.status(500).send({ error: 'Failed to fetch run details' });
      }
  });

  // GET /runs/:id/evidence - Download evidence bundle
  protectedRoutes.get('/runs/:id/evidence', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      // Check ownership
      const run = await db
        .selectFrom('runs')
        .select('user_id')
        .where('id', '=', id)
        .where('user_id', '=', request.user.id)
        .executeTakeFirst();

      if (!run) {
        return reply.status(404).send({ error: 'Run not found' });
      }

      const bundle = await db
        .selectFrom('evidence_bundles')
        .selectAll()
        .where('run_id', '=', id)
        .executeTakeFirst();

      if (!bundle) {
         // If missing, we could trigger it, but per guide we treat as error/not ready or maybe trigger
         // Let's return 404 for now or trigger it? Guide says "require all completed runs have evidence entries".
         return reply.status(404).send({ error: 'Evidence bundle record not found' });
      }

      if (bundle.status === 'pending') {
         return reply.status(202).send({ status: 'pending' });
      }

      if (bundle.status === 'error') {
         return reply.status(500).send({ status: 'error', message: bundle.error_message });
      }

      if (bundle.status === 'ready' && bundle.bundle_path) {
         if (fs.existsSync(bundle.bundle_path)) {
             const stream = fs.createReadStream(bundle.bundle_path);
             reply.header('Content-Type', 'application/zip');
             reply.header('Content-Disposition', `attachment; filename="evidence-${id}.zip"`);
             return reply.send(stream);
         } else {
             return reply.status(500).send({ error: 'Bundle file missing on disk' });
         }
      }

      return reply.status(404).send({ error: 'Evidence not available' });

    } catch (error) {
       request.log.error(error);
       return reply.status(500).send({ error: 'Failed to fetch evidence' });
    }
  });
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
};

start();