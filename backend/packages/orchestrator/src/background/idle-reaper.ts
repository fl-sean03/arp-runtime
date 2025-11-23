import { Kysely, sql } from 'kysely';
import { Database } from '@codex/shared';
import { WorkspaceManager } from '@codex/workspace-manager';

export function startIdleReaper(db: Kysely<Database>, workspaceManager: WorkspaceManager) {
  console.log('Starting idle reaper...');
  
  // Run every 60 seconds
  setInterval(async () => {
    await reapIdleWorkspaces(db, workspaceManager);
  }, 60 * 1000);

  // Also run immediately on startup
  reapIdleWorkspaces(db, workspaceManager).catch(err => {
    console.error('Error in initial reap:', err);
  });
}

async function reapIdleWorkspaces(db: Kysely<Database>, workspaceManager: WorkspaceManager) {
  try {
    // 1. Find workspaces that are warm AND expired
    const now = new Date();
    const idleWorkspaces = await db
      .selectFrom('workspaces')
      .select(['id', 'container_id'])
      .where('state', '=', 'warm')
      .where('idle_expires_at', '<', now)
      .where('container_id', 'is not', null)
      .execute();

    if (idleWorkspaces.length === 0) {
      return;
    }

    console.log(`Found ${idleWorkspaces.length} idle workspaces to stop.`);

    for (const ws of idleWorkspaces) {
      if (!ws.container_id) continue;

      console.log(`Stopping idle workspace ${ws.id} (container: ${ws.container_id})`);
      
      // 2. Stop container
      await workspaceManager.stopWorkspace(ws.container_id);

      // 3. Update DB to cold
      await db
        .updateTable('workspaces')
        .set({
          state: 'cold',
          container_id: null,
          // We keep thread_id and volume_name!
        })
        .where('id', '=', ws.id)
        .execute();
        
      console.log(`Workspace ${ws.id} is now cold.`);
    }

  } catch (error) {
    console.error('Error in idle reaper:', error);
  }
}