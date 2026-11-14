import { loadConfig } from './config/config.js';
import { assertProductionAuthenticator } from './auth/authenticator.js';
import { buildApp } from './app.js';
import { createPrismaClient } from './db/prisma.js';
import { PrismaWorkspaceRepository } from './workspaces/prisma-workspace-repository.js';
import { WorkspaceService } from './workspaces/workspace-service.js';
import { PrismaInvitationRepository } from './invitations/prisma-invitation-repository.js';
import { InvitationService } from './invitations/invitation-service.js';
import { PrismaTeamRepository } from './teams/prisma-team-repository.js';
import { TeamService } from './teams/team-service.js';
import { PrismaMembershipRepository } from './memberships/prisma-membership-repository.js';
import { WorkspaceMembershipService } from './memberships/membership-service.js';
import { composeAuthStack } from './auth-flow/composition.js';
import { loadOidcProviderConfiguration } from './identity/oidc-provider.js';
import { createRuntimeRateLimiters } from './rate-limit/runtime.js';
import { loadBootstrapConfiguration } from './bootstrap/config.js';
import { loadMetricsAuthorizer } from './observability/config.js';

const config = loadConfig();
const prisma = createPrismaClient(config);
const oidcConfigured = loadOidcProviderConfiguration() !== null;
if (oidcConfigured && config.TRUST_PROXY === 'true') {
  throw new Error('Configured authentication requires an explicit trusted proxy policy');
}
const rateLimiters = oidcConfigured ? createRuntimeRateLimiters(prisma, process.env) : undefined;
const bootstrap = loadBootstrapConfiguration(process.env);
const metricsAuthorizer = loadMetricsAuthorizer(process.env);
if (bootstrap && !oidcConfigured) throw new Error('Bootstrap requires configured authentication');
if (bootstrap && process.env.RATE_LIMIT_HMAC_KEY === bootstrap.expectedGrantHash.toString('base64url')) {
  throw new Error('Bootstrap grant and rate-limit keys must differ');
}
const auth = await composeAuthStack({
  config,
  prisma,
  sessionPolicy: { idleTimeoutMs: 30 * 60_000, absoluteTimeoutMs: 24 * 60 * 60_000, touchIntervalMs: 5 * 60_000 },
  ...(rateLimiters ? { rateLimiters: rateLimiters.auth } : {}),
  ...(bootstrap ? { bootstrap } : {}),
});
assertProductionAuthenticator(config.NODE_ENV, auth.authenticator);
const app = buildApp({
  config,
  authenticator: auth.authenticator,
  ...(auth.configured ? { authRoutes: { mountPath: auth.mountPath, router: auth.router } } : {}),
  ...(rateLimiters ? { invitationRateLimiters: rateLimiters.invitations } : {}),
  ...(metricsAuthorizer ? { metricsAuthorizer } : {}),
  readinessProbe: { query: async () => { await prisma.$queryRaw`SELECT 1`; } },
  workspaceService: new WorkspaceService(new PrismaWorkspaceRepository(prisma)),
  invitationService: new InvitationService(new PrismaInvitationRepository(prisma)),
  teamService: new TeamService(new PrismaTeamRepository(prisma)),
  membershipService: new WorkspaceMembershipService(new PrismaMembershipRepository(prisma))
});
const server = app.listen(config.PORT, config.HOST, () => {
  console.info(`API listening on ${config.HOST}:${config.PORT}`);
});
server.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
  void prisma.$disconnect();
});
const shutdown = () => server.close(() => { void prisma.$disconnect(); });
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
