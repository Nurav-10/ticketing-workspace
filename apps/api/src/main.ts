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
import { IssueApplicationService } from './issues/issue-service.js';
import { PrismaIssueRepository } from './issues/prisma-issue-repository.js';
import { IssueAssigneeApplicationService, PrismaIssueAssigneeRepository } from './issues/issue-assignees.js';
import { CommentApplicationService } from './comments/comment-service.js';
import { PrismaCommentRepository } from './comments/prisma-comment-repository.js';
import { PlanningApplicationService } from './planning/planning-service.js';
import { PrismaPlanningRepository } from './planning/prisma-planning-repository.js';
import { WorkflowApplicationService } from './workflows/workflow-service.js';
import { PrismaWorkflowRepository } from './workflows/prisma-workflow-repository.js';
import { LabelApplicationService } from './labels/label-service.js';
import { PrismaLabelRepository } from './labels/prisma-label-repository.js';
import { loadIssueSearchCursorKey } from './search/issue-search-config.js';
import { IssueSearchApplicationService } from './search/issue-search-service.js';
import { PrismaIssueSearchRepository } from './search/prisma-issue-search-repository.js';
import { IssueLabelApplicationService } from './labels/issue-label-service.js';
import { PrismaIssueLabelRepository } from './labels/prisma-issue-label-repository.js';

const config = loadConfig();
const prisma = createPrismaClient(config);
const oidcConfigured = loadOidcProviderConfiguration() !== null;
if (oidcConfigured && config.TRUST_PROXY === 'true') {
  throw new Error('Configured authentication requires an explicit trusted proxy policy');
}
const rateLimiters = oidcConfigured ? createRuntimeRateLimiters(prisma, process.env) : undefined;
const bootstrap = loadBootstrapConfiguration(process.env);
const metricsAuthorizer = loadMetricsAuthorizer(process.env);
const issueSearchCursorKey = loadIssueSearchCursorKey(process.env);
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
  membershipService: new WorkspaceMembershipService(new PrismaMembershipRepository(prisma)),
  issueService: new IssueApplicationService(new PrismaIssueRepository(prisma)),
  issueAssigneeService: new IssueAssigneeApplicationService(new PrismaIssueAssigneeRepository(prisma)),
  commentService: new CommentApplicationService(new PrismaCommentRepository(prisma)),
  planningService: new PlanningApplicationService(new PrismaPlanningRepository(prisma)),
  workflowService: new WorkflowApplicationService(new PrismaWorkflowRepository(prisma), prisma),
  labelService: new LabelApplicationService(new PrismaLabelRepository(prisma)),
  issueLabelService: new IssueLabelApplicationService(new PrismaIssueLabelRepository(prisma)),
  ...(issueSearchCursorKey ? { issueSearchService: new IssueSearchApplicationService(new PrismaIssueSearchRepository(prisma, issueSearchCursorKey)) } : {}),
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
