import type { FastifyInstance } from 'fastify';

export interface ReadinessProbe { query(sql: string): Promise<unknown>; }

export function registerHealthRoutes(app: FastifyInstance, probe: ReadinessProbe): void {
  app.get('/api/v1/health', async () => ({ status: 'ok' }));
  app.get('/api/v1/ready', async (_request, reply) => {
    try { await probe.query('SELECT 1'); return { status: 'ready' }; }
    catch { return reply.code(503).send({ error: { code: 'not_ready', message: 'Service dependencies are unavailable' } }); }
  });
}
