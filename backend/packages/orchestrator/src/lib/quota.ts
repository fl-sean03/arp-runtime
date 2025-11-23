import { Kysely, sql } from 'kysely';
import { Database } from '@codex/shared';

const DEFAULT_MAX_RUNS = 500;

export async function checkQuota(db: Kysely<Database>, userId: string): Promise<boolean> {
  const maxRuns = parseInt(process.env.MAX_RUNS_PER_DAY || String(DEFAULT_MAX_RUNS), 10);
  
  // Calculate start of current day in UTC
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const result = await db
    .selectFrom('runs')
    .select(db.fn.count('id').as('count'))
    .where('user_id', '=', userId)
    .where('started_at', '>=', startOfDay)
    .executeTakeFirst();

  const count = Number(result?.count || 0);
  
  return count < maxRuns;
}