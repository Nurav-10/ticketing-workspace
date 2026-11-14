import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { Config } from './config/config.js';
import type { Authenticator } from './auth/authenticator.js';
import { createRequestId, authenticateAndCheckOrigin } from './http/request-boundary.js';
import { registerErrorHandler } from './http/error-handler.js';
import { registerHealthRoutes, type ReadinessProbe } from './http/health-routes.js';
import { registerOpenApiRoute } from './http/openapi-route.js';
import { registerWorkspaceRoutes } from './workspaces/workspace-routes.js';
import type { WorkspaceLister } from './workspaces/workspace-service.js';
import { registerInvitationRoutes } from './invitations/invitation-routes.js';
import type { InvitationRedeemer } from './invitations/invitation-service.js';

export interface AppOptions {
  config: Config;
  authenticator: Authenticator;
  readinessProbe: ReadinessProbe;
  workspaceService: WorkspaceLister;
  invitationService: InvitationRedeemer;
}

export async function buildApp({ config, authenticator, readinessProbe, workspaceService, invitationService }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY === 'true',
    genReqId: createRequestId,
    logger: { level: config.NODE_ENV === 'production' ? 'info' : 'debug', redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'], censor: '[REDACTED]' } }
  });
  await app.register(cookie);
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request, reply) => { reply.header('x-request-id', request.id); });
  registerErrorHandler(app);
  registerHealthRoutes(app, readinessProbe);
  registerOpenApiRoute(app);
  await app.register(async (protectedRoutes) => {
    protectedRoutes.addHook('preHandler', async (request) => {
      await authenticateAndCheckOrigin(request, authenticator, config.SESSION_COOKIE_NAME, config.PUBLIC_ORIGIN);
    });
    registerWorkspaceRoutes(protectedRoutes, workspaceService);
    registerInvitationRoutes(protectedRoutes, invitationService);
  });
  return app;
}
