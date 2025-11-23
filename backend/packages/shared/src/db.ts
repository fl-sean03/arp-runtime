import { Kysely, PostgresDialect, Generated } from 'kysely';
import { Pool } from 'pg';

export interface UsersTable {
  id: Generated<string>;
  email: string | null;
  name: string | null;
  is_admin: boolean;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ApiKeysTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  label: string | null;
  created_at: Generated<Date>;
  revoked_at: Date | null;
}

export interface ProjectsTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  repo_url: string;
  created_at: Generated<Date>;
}

export interface WorkspacesTable {
  id: Generated<string>;
  user_id: string;
  project_id: string;
  state: 'warm' | 'cold' | 'error' | 'deleted';
  container_id: string | null;
  volume_name: string | null;
  thread_id: string | null;
  image_name: string | null;
  image_digest: string | null;
  runtime_metadata: any | null; // Using any for JSONB flexibility
  last_active_at: Generated<Date>;
  idle_expires_at: Date | null;
}

export interface RunsTable {
  id: Generated<string>;
  user_id: string;
  project_id: string;
  workspace_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout';
  prompt: string;
  final_text: string | null;
  diff: string | null;
  test_output: string | null;
  error_message: string | null;
  started_at: Generated<Date>;
  finished_at: Date | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  git_commit: string | null;
  image_name: string | null;
  image_digest: string | null;
  env_snapshot: any | null; // Using any for JSONB
}

export interface EvidenceBundlesTable {
  id: Generated<string>;
  run_id: string;
  user_id: string;
  project_id: string;
  workspace_id: string;
  status: 'pending' | 'ready' | 'error' | 'deleted';
  bundle_path: string | null;
  error_message: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  api_keys: ApiKeysTable;
  projects: ProjectsTable;
  workspaces: WorkspacesTable;
  runs: RunsTable;
  evidence_bundles: EvidenceBundlesTable;
}

export const createDb = (connectionString: string) => {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
      }),
    }),
  });
};