import type { ValidatedProviderIdentity } from '../identity-persistence/identity-repository.js';

export interface BootstrapWorkspace {
  name: string;
  slug: string;
}

export interface CreateBootstrapAccount {
  identity: ValidatedProviderIdentity;
  workspace: BootstrapWorkspace;
}

export type BootstrapResult =
  | { kind: 'created'; userId: string; workspaceId: string }
  | { kind: 'unavailable' };

/**
 * Atomic first-workspace provisioning port. Implementations must serialize all
 * bootstrap attempts and commit user, identity, workspace, and owner membership
 * together only when the database contains no workspace.
 */
export interface BootstrapRepository {
  createFirstWorkspace(input: CreateBootstrapAccount): Promise<BootstrapResult>;
}
