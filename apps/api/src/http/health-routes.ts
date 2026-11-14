import type { Express, Request, Response } from 'express';

export interface ReadinessProbe { query(): Promise<unknown>; }

export function registerHealthRoutes(app: Express, probe: ReadinessProbe): void {
  app.get('/api/v1/health', (_request: Request, response: Response) => { response.json({ status: 'ok' }); });
  app.get('/api/v1/ready', async (request: Request, response: Response) => {
    try { await probe.query(); response.json({ status: 'ready' }); }
    catch { response.status(503).json({ error: { code: 'not_ready', message: 'Service dependencies are unavailable', requestId: request.id } }); }
  });
}
