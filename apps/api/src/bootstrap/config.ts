import type { BootstrapCompositionOptions } from '../auth-flow/composition.js';

/** Enable bootstrap only through complete, trusted deployment configuration. */
export function loadBootstrapConfiguration(env: NodeJS.ProcessEnv): BootstrapCompositionOptions | undefined {
  const values = [env.BOOTSTRAP_GRANT_HASH, env.BOOTSTRAP_WORKSPACE_NAME, env.BOOTSTRAP_WORKSPACE_SLUG];
  if (values.every((value) => value === undefined || value === '')) return undefined;
  const [encoded, name, slug] = values;
  if (!encoded || !name || !slug || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error('Invalid bootstrap configuration');
  const expectedGrantHash = Buffer.from(encoded, 'base64url');
  if (expectedGrantHash.length !== 32 || expectedGrantHash.toString('base64url') !== encoded) {
    throw new Error('Invalid bootstrap configuration');
  }
  return { expectedGrantHash, workspace: { name, slug } };
}
