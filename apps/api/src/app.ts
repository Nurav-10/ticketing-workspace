import express, { type Express, type RequestHandler, type Router } from "express";
import cookieParser from "cookie-parser";
import type { Config } from "./config/config.js";
import type { Authenticator } from "./auth/authenticator.js";
import {
  createRequestId,
  authenticateAndCheckOrigin,
} from "./http/request-boundary.js";
import { registerErrorHandler } from "./http/error-handler.js";
import {
  registerHealthRoutes,
  type ReadinessProbe,
} from "./http/health-routes.js";
import { registerOpenApiRoute } from "./http/openapi-route.js";
import { registerWorkspaceRoutes } from "./workspaces/workspace-routes.js";
import type { WorkspaceLister } from "./workspaces/workspace-service.js";
import { registerInvitationRoutes } from "./invitations/invitation-routes.js";
import type { InvitationAdministrator } from "./invitations/invitation-service.js";
import { registerTeamRoutes } from './teams/team-routes.js';
import type { TeamAdministrator, TeamLister } from './teams/team-service.js';
import { registerMembershipRoutes } from './memberships/membership-routes.js';
import type { WorkspaceMembershipAdministrator } from './memberships/membership-service.js';
import { ApiMetrics, createHttpMetricsMiddleware, createMetricsRouter, type MetricsAuthorizer } from './observability/metrics.js';
import { registerIssueRoutes } from './issues/issue-routes.js';
import type { IssueService } from './issues/issue-service.js';
import { registerIssueAssigneeRoutes, type IssueAssigneeService } from './issues/issue-assignees.js';
import { registerCommentRoutes } from './comments/comment-routes.js';
import type { CommentService } from './comments/comment-service.js';
import { registerPlanningRoutes } from './planning/planning-routes.js';
import type { PlanningService } from './planning/planning-service.js';
import { registerWorkflowRoutes } from './workflows/workflow-routes.js';
import type { WorkflowService } from './workflows/workflow-service.js';
import { registerLabelRoutes } from './labels/label-routes.js';
import type { LabelApplicationService } from './labels/label-service.js';

export interface AppOptions {
  config: Config;
  authenticator: Authenticator;
  readinessProbe: ReadinessProbe;
  workspaceService: WorkspaceLister;
  invitationService: InvitationAdministrator;
  teamService: TeamLister & TeamAdministrator;
  membershipService: WorkspaceMembershipAdministrator;
  authRoutes?: { mountPath: string; router: Router };
  invitationRateLimiters?: { issue: RequestHandler; redeem: RequestHandler; list: RequestHandler; search: RequestHandler };
  metricsAuthorizer?: MetricsAuthorizer;
  issueService?: IssueService;
  issueAssigneeService?: IssueAssigneeService;
  commentService?: CommentService;
  planningService?: PlanningService;
  workflowService?: WorkflowService;
  labelService?: LabelApplicationService;
}

export function buildApp({
  config,
  authenticator,
  readinessProbe,
  workspaceService,
  invitationService,
  teamService,
  membershipService,
  authRoutes,
  invitationRateLimiters,
  metricsAuthorizer,
  issueService,
  issueAssigneeService,
  commentService,
  planningService,
  workflowService,
  labelService,
}: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY === "true");
  app.use((request, response, next) => {
    request.id = createRequestId(request);
    response.setHeader("x-request-id", request.id);
    next();
  });
  if (metricsAuthorizer) {
    const metrics = new ApiMetrics();
    app.use(createHttpMetricsMiddleware(metrics));
    app.use(createMetricsRouter(metrics, metricsAuthorizer));
  }
  // Protected resources can contain tenant data, including in error responses.
  // Set this before body parsing and authentication so failures are covered too.
  app.use(['/api/v1/workspaces', '/api/v1/invitations'], (_request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    next();
  });
  app.use(cookieParser());
  // A 20,000-character description can occupy 120,000 JSON bytes when every
  // character needs a six-byte `\uXXXX` escape. Keep that larger bound scoped
  // to issue requests; the API's general JSON limit remains 32kb.
  app.use('/api/v1/workspaces/:workspaceId/teams/:teamId/issues', express.json({ limit: '128kb', strict: true }));
  app.use(express.json({ limit: "32kb", strict: true }));
  registerHealthRoutes(app, readinessProbe);
  registerOpenApiRoute(app);
  app.get('/api/v1/auth/status', (_request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.json({ data: { available: Boolean(authRoutes) } });
  });
  if (authRoutes) app.use(authRoutes.mountPath, authRoutes.router);
  const protectedRoutes = express.Router();
  const protect: RequestHandler = async (request, _response, next) => {
    try {
      await authenticateAndCheckOrigin(
        request,
        authenticator,
        config.SESSION_COOKIE_NAME,
        config.PUBLIC_ORIGIN,
      );
      next();
    } catch (error) {
      next(error);
    }
  };
  protectedRoutes.use("/workspaces", protect);
  protectedRoutes.use("/invitations", protect);
  if (invitationRateLimiters) {
    protectedRoutes.post('/workspaces/:workspaceId/invitations', invitationRateLimiters.issue);
    protectedRoutes.get('/workspaces/:workspaceId/invitations', invitationRateLimiters.list);
    protectedRoutes.post('/workspaces/:workspaceId/invitations/search', invitationRateLimiters.search);
    protectedRoutes.post('/invitations/redeem', invitationRateLimiters.redeem);
  }
  registerWorkspaceRoutes(protectedRoutes, workspaceService);
  registerInvitationRoutes(protectedRoutes, invitationService);
  registerTeamRoutes(protectedRoutes, teamService);
  registerMembershipRoutes(protectedRoutes, membershipService);
  if (issueService) registerIssueRoutes(protectedRoutes, issueService);
  if (issueAssigneeService) registerIssueAssigneeRoutes(protectedRoutes, issueAssigneeService);
  if (commentService) registerCommentRoutes(protectedRoutes, commentService);
  if (planningService) registerPlanningRoutes(protectedRoutes, planningService);
  if (workflowService) registerWorkflowRoutes(protectedRoutes, workflowService);
  if (labelService) registerLabelRoutes(protectedRoutes, labelService);
  app.use("/api/v1", protectedRoutes);
  registerErrorHandler(app);
  return app;
}
