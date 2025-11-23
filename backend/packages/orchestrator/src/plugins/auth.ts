import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { Kysely } from 'kysely';
import { Database } from '@codex/shared';
import { createHash } from 'crypto';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      id: string;
      is_admin: boolean;
    };
  }
}

interface AuthPluginOptions {
  db: Kysely<Database>;
}

export const authCheck = async (request: FastifyRequest, reply: FastifyReply, db: Kysely<Database>) => {
    // Skip auth for healthz
    if (request.url === '/healthz') {
      return;
    }

    const apiKey = request.headers['x-api-key'];

    if (!apiKey || typeof apiKey !== 'string') {
      return reply.status(401).send({ error: 'Unauthorized: Missing API Key' });
    }

    const hash = createHash('sha256').update(apiKey).digest('hex');

    try {
      const result = await db
        .selectFrom('api_keys')
        .innerJoin('users', 'users.id', 'api_keys.user_id')
        .select(['users.id', 'users.is_admin', 'api_keys.revoked_at'])
        .where('api_keys.token_hash', '=', hash)
        .executeTakeFirst();

      if (!result || result.revoked_at) {
        return reply.status(401).send({ error: 'Unauthorized: Invalid API Key' });
      }

      request.user = {
        id: result.id,
        is_admin: result.is_admin
      };

    } catch (err) {
      request.log.error({ err }, 'Auth check failed');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }
};

export const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
  const { db } = options;
  fastify.addHook('onRequest', async (request, reply) => {
      await authCheck(request, reply, db);
  });
};