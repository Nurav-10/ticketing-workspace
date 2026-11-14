import type { FastifyInstance } from 'fastify';

export function registerOpenApiRoute(app: FastifyInstance): void {
  app.get('/api/v1/openapi.json', async () => ({
    openapi: '3.1.0', info: { title: 'Ticketing API', version: '1.0.0' },
    paths: {
      '/api/v1/health': { get: { summary: 'Liveness', responses: { '200': { description: 'Process is alive' } } } },
      '/api/v1/ready': { get: { summary: 'Readiness', responses: { '200': { description: 'Dependencies are available' }, '503': { description: 'A dependency is unavailable' } } } },
      '/api/v1/workspaces': { get: { summary: 'List workspaces for the authenticated user', responses: { '200': { description: 'Workspace memberships' }, '401': { description: 'Authentication required' } } } },
      '/api/v1/invitations/redeem': { post: { summary: 'Redeem a single-use invitation using the verified account email', responses: { '200': { description: 'Membership created' }, '400': { description: 'Invalid request' }, '403': { description: 'Origin or invited email rejected' }, '404': { description: 'Invitation unavailable' }, '409': { description: 'Already a member' } } } }
    }
  }));
}
