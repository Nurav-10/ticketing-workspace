import { loadConfig } from './config/config.js';
import { assertProductionAuthenticator, UnconfiguredAuthenticator } from './auth/authenticator.js';
import { buildApp } from './app.js';
import { createPool } from './db/pool.js';
import { PostgresWorkspaceRepository } from './workspaces/postgres-workspace-repository.js';
import { WorkspaceService } from './workspaces/workspace-service.js';
import { PostgresInvitationRepository } from './invitations/postgres-invitation-repository.js';
import { InvitationService } from './invitations/invitation-service.js';

const config = loadConfig();
const authenticator = new UnconfiguredAuthenticator();
assertProductionAuthenticator(config.NODE_ENV, authenticator);
const pool = createPool(config);
const app = await buildApp({
  config,
  authenticator,
  readinessProbe: pool,
  workspaceService: new WorkspaceService(new PostgresWorkspaceRepository(pool)),
  invitationService: new InvitationService(new PostgresInvitationRepository(pool))
});
app.addHook('onClose', async () => { await pool.end(); });
try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
