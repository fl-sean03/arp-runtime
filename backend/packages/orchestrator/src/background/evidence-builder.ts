import { Database } from '@codex/shared';
import { WorkspaceManager } from '@codex/workspace-manager';
import { Kysely } from 'kysely';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { logger } from '../logger';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

const execAsync = util.promisify(exec);

export class EvidenceBuilder {
  private db: Kysely<Database>;
  private workspaceManager: WorkspaceManager;
  private evidenceRoot: string;

  constructor(db: Kysely<Database>, workspaceManager: WorkspaceManager) {
    this.db = db;
    this.workspaceManager = workspaceManager;
    this.evidenceRoot = process.env.EVIDENCE_ROOT || path.resolve(__dirname, '../../../../evidence');
    
    // Ensure evidence root exists
    if (!fs.existsSync(this.evidenceRoot)) {
      fs.mkdirSync(this.evidenceRoot, { recursive: true });
    }
  }

  async buildBundle(runId: string) {
    logger.info({ runId }, 'Starting evidence bundle build');

    try {
      // 1. Fetch run & workspace data
      const run = await this.db
        .selectFrom('runs')
        .selectAll()
        .where('id', '=', runId)
        .executeTakeFirst();

      if (!run) {
        throw new Error(`Run ${runId} not found`);
      }

      const workspace = await this.db
        .selectFrom('workspaces')
        .selectAll()
        .where('id', '=', run.workspace_id)
        .executeTakeFirst();

      if (!workspace || !workspace.container_id) {
         // Even if workspace is cold/gone, we might want to handle this gracefully if we had persistence.
         // But for now, we assume we need the container to pull files.
         // If container is gone, we fail.
         throw new Error(`Workspace container not found for run ${runId}`);
      }

      // 2. Setup temp directories
      const tempDir = path.join(this.evidenceRoot, 'temp', runId);
      const extractDir = path.join(tempDir, 'extract'); // Where we extract docker tar
      const bundleDir = path.join(tempDir, 'bundle', runId); // The final structure to zip

      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      fs.mkdirSync(extractDir, { recursive: true });
      fs.mkdirSync(bundleDir, { recursive: true });

      // 3. Get container archive
      // We expect evidence at /workspace/evidence/<runId>
      // Docker cp behavior: copying /path/to/dir returns a tar containing that dir.
      const containerPath = `/workspace/evidence/${runId}`;
      logger.info({ runId, containerPath }, 'Fetching archive from container');
      
      const tarStream = await this.workspaceManager.getContainerArchive(workspace.container_id, containerPath);
      const tarDest = path.join(tempDir, 'evidence.tar');
      await pipeline(tarStream, fs.createWriteStream(tarDest));

      // 4. Extract tar
      // tar -xf evidence.tar -C extractDir
      await execAsync(`tar -xf ${tarDest} -C ${extractDir}`);

      // 5. Move files to bundle dir
      // The tar from docker usually contains the directory name as the top level if we asked for a dir.
      // So it might be extractDir/runId/... or extractDir/... depending on how we asked.
      // Let's inspect what we got or just move everything from extractDir to bundleDir.
      // Since we want the structure inside zip to be <runId>/..., and we created bundleDir as .../bundle/<runId>
      // We should copy the contents of the extracted evidence to bundleDir.
      
      // Check structure
      // If we cp /workspace/evidence/<runId>, the tar likely contains <runId>/...
      // So inside extractDir we should have a folder named <runId> (or whatever the last path component was).
      
      const extractedItems = fs.readdirSync(extractDir);
      // We expect one folder matching the runId or the folder name we requested
      if (extractedItems.length > 0) {
          // Move contents to bundleDir
          // Actually, if extractDir has `runId` folder, and bundleDir IS `runId` folder, we can just sync/copy.
          // But we want to be explicit.
          // Let's just copy extracted contents to bundleDir.
          // If extractedItems[0] is the directory, we move its contents.
          const sourcePath = path.join(extractDir, extractedItems[0]);
          if (fs.statSync(sourcePath).isDirectory()) {
             await execAsync(`cp -r ${sourcePath}/* ${bundleDir}/ 2>/dev/null || true`);
             // Also copy hidden files if any? standard glob might miss them.
             // simpler: cp -r ${sourcePath}/. ${bundleDir}/
             await execAsync(`cp -r ${sourcePath}/. ${bundleDir}/ 2>/dev/null || true`);
          } else {
              // It was a file? unexpected but copy it.
               await execAsync(`cp ${sourcePath} ${bundleDir}/`);
          }
      }

      // 6. Generate metadata files
      const metadata = {
        run: run,
        workspace: workspace,
        generatedAt: new Date().toISOString()
      };

      const envSnapshot = {
        runSnapshot: run.env_snapshot,
        workspaceMetadata: workspace.runtime_metadata
      };

      fs.writeFileSync(path.join(bundleDir, 'metadata.json'), JSON.stringify(metadata, null, 2));
      fs.writeFileSync(path.join(bundleDir, 'env_snapshot.json'), JSON.stringify(envSnapshot, null, 2));
      
      if (run.diff) {
          fs.writeFileSync(path.join(bundleDir, 'diff.patch'), run.diff);
      }

      // 7. Zip it up
      // cd temp/bundle && zip -r ../../<runId>.zip .
      // Output file
      const zipFileName = `${runId}.zip`;
      const zipFilePath = path.join(this.evidenceRoot, zipFileName);
      
      // We want the zip to contain the folder <runId>/...
      // So we should zip from tempDir/bundle directory which contains <runId> directory? 
      // Wait, bundleDir = tempDir/bundle/runId.
      // So if we zip from tempDir/bundle, we get runId/... in the zip.
      
      await execAsync(`cd ${path.join(tempDir, 'bundle')} && zip -r ${zipFilePath} .`);

      // 8. Update DB
      await this.db
        .updateTable('evidence_bundles')
        .set({
          status: 'ready',
          bundle_path: zipFilePath,
          updated_at: new Date()
        })
        .where('run_id', '=', runId)
        .execute();

      logger.info({ runId, zipFilePath }, 'Evidence bundle built successfully');

      // Cleanup temp
      fs.rmSync(tempDir, { recursive: true, force: true });

    } catch (error: any) {
      logger.error({ runId, err: error }, 'Failed to build evidence bundle');
      await this.db
        .updateTable('evidence_bundles')
        .set({
          status: 'error',
          error_message: error.message || 'Unknown error',
          updated_at: new Date()
        })
        .where('run_id', '=', runId)
        .execute();
    }
  }
}