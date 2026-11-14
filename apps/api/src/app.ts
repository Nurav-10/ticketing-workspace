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

export interface AppOptions {
  config: Config;
  authenticator: Authenticator;
  readinessProbe: ReadinessProbe;
  workspaceService: WorkspaceLister;
  invitationService: InvitationAdministrator;
  teamService: TeamLister & TeamAdministrator;
  membershipService: WorkspaceMembershipAdministrator;
  authRoutes?: { mountPath: string; router: Router };
  invitationRateLimiters?: { issue: RequestHandler; redeem: RequestHandler };
  metricsAuthorizer?: MetricsAuthorizer;
  issueService?: IssueService;
  issueAssigneeService?: IssueAssigneeService;
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
  app.use(cookieParser());
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
    protectedRoutes.post('/invitations/redeem', invitationRateLimiters.redeem);
  }
  registerWorkspaceRoutes(protectedRoutes, workspaceService);
  registerInvitationRoutes(protectedRoutes, invitationService);
  registerTeamRoutes(protectedRoutes, teamService);
  registerMembershipRoutes(protectedRoutes, membershipService);
  if (issueService) registerIssueRoutes(protectedRoutes, issueService);
  if (issueAssigneeService) registerIssueAssigneeRoutes(protectedRoutes, issueAssigneeService);
  app.use("/api/v1", protectedRoutes);
  registerErrorHandler(app);
  return app;
}
