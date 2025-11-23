import { Kysely, sql } from 'kysely';
import { Database } from '@codex/shared';
import { WorkspaceManager } from '@codex/workspace-manager';
import fs from 'fs/promises';
import { metrics } from '../metrics';
import { logger } from '../logger';

const WORKSPACE_COLD_TTL_DAYS = parseInt(process.env.WORKSPACE_COLD_TTL_DAYS || '30', 10);
const EVIDENCE_TTL_DAYS = parseInt(process.env.EVIDENCE_TTL_DAYS || '180', 10);

export function startGCWorker(db: Kysely<Database>, workspaceManager: WorkspaceManager) {
  logger.info({ msg: 'Starting GC worker', WORKSPACE_COLD_TTL_DAYS, EVIDENCE_TTL_DAYS });

  // Run GC every hour by default, or configurable
  // For v0.3 dev, we can stick to a simpler interval
  const intervalMs = 60 * 60 * 1000; // 1 hour

  setInterval(async () => {
    await runWorkspaceGC(db, workspaceManager);
    await runEvidenceGC(db);
  }, intervalMs);

  // Also run once on startup (with a small delay to let things settle)
  setTimeout(async () => {
    await runWorkspaceGC(db, workspaceManager);
    await runEvidenceGC(db);
  }, 5000);
}

// Exposed for testing/manual trigger
export async function runWorkspaceGC(db: Kysely<Database>, workspaceManager: WorkspaceManager) {
  try {
    const limitDate = new Date(Date.now() - WORKSPACE_COLD_TTL_DAYS * 24 * 60 * 60 * 1000);
    
    logger.info({ msg: 'Running Workspace GC', limitDate });

    // Find cold workspaces older than limit
    const coldWorkspaces = await db
      .selectFrom('workspaces')
      .select(['id', 'volume_name'])
      .where('state', '=', 'cold')
      .where('last_active_at', '<', limitDate)
      .where('volume_name', 'is not', null)
      .execute();

    if (coldWorkspaces.length === 0) {
      return;
    }

    logger.info({ msg: `Found ${coldWorkspaces.length} expired cold workspaces`, count: coldWorkspaces.length });

    for (const ws of coldWorkspaces) {
      if (ws.volume_name) {
        await workspaceManager.deleteVolume(ws.volume_name);
      }

      // Mark as deleted
      await db
        .updateTable('workspaces')
        .set({
          state: 'deleted', // 'deleted' isn't in original schema enum, but schema was TEXT, so it should fit. 
                            // If schema enforces specific strings, we might need to update schema or re-use 'error' 
                            // but 'deleted' is explicit.
          volume_name: null
        })
        .where('id', '=', ws.id)
        .execute();

      metrics.increment('arp_workspace_gc_total');
      logger.info({ msg: 'GC deleted workspace volume', workspaceId: ws.id });
    }
  } catch (err) {
    logger.error({ err }, 'Error in Workspace GC');
  }
}

export async function runEvidenceGC(db: Kysely<Database>) {
  try {
    const limitDate = new Date(Date.now() - EVIDENCE_TTL_DAYS * 24 * 60 * 60 * 1000);

    logger.info({ msg: 'Running Evidence GC', limitDate });

    const oldBundles = await db
      .selectFrom('evidence_bundles')
      .select(['id', 'bundle_path'])
      .where('status', '=', 'ready')
      .where('created_at', '<', limitDate)
      .where('bundle_path', 'is not', null)
      .execute();

    if (oldBundles.length === 0) {
      return;
    }

    logger.info({ msg: `Found ${oldBundles.length} expired evidence bundles`, count: oldBundles.length });

    for (const bundle of oldBundles) {
      if (bundle.bundle_path) {
        try {
          await fs.unlink(bundle.bundle_path);
          logger.info({ msg: 'GC deleted evidence file', path: bundle.bundle_path });
        } catch (e: any) {
            // If file missing, that's fine, still mark deleted
            if (e.code !== 'ENOENT') {
                logger.warn({ err: e, path: bundle.bundle_path }, 'Failed to delete evidence file');
                // If we can't delete the file, do we still mark DB as deleted?
                // Yes, to prevent retry loop on permission errors, or we can skip.
                // Let's proceed to mark as deleted so we don't get stuck.
            }
        }
      }

      await db
        .updateTable('evidence_bundles')
        .set({
          status: 'deleted', // Assuming 'deleted' fits in TEXT column
          bundle_path: null
        })
        .where('id', '=', bundle.id)
        .execute();

      metrics.increment('arp_evidence_gc_total');
    }

  } catch (err) {
    logger.error({ err }, 'Error in Evidence GC');
  }
}