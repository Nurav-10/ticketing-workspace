import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import type { ValidatedProviderIdentity } from '../src/identity-persistence/identity-repository.js';
import type { BootstrapRepository, CreateBootstrapAccount } from '../src/bootstrap/bootstrap-repository.js';
import { BootstrapService, deriveBootstrapGrantHash } from '../src/bootstrap/bootstrap-service.js';

const operatorSecret = randomBytes(32).toString('base64url');
const expectedGrantHash = createHash('sha256').update(Buffer.from(operatorSecret, 'base64url')).digest();
const workspace = { name: 'First Workspace', slug: 'first-workspace' };
const identity: ValidatedProviderIdentity = {
  issuer: 'https://issuer.example/',
  subject: 'provider-subject-1',
  email: 'owner@example.test',
  emailVerified: true,
  displayName: 'Initial Owner',
};

class FakeBootstrapRepository implements BootstrapRepository {
  calls: CreateBootstrapAccount[] = [];
  result = { kind: 'created' as const, userId: 'user-1', workspaceId: 'workspace-1' };
  error: unknown;

  async createFirstWorkspace(input: CreateBootstrapAccount) {
    this.calls.push(input);
    if (this.error) throw this.error;
    return this.result;
  }
}

test('derives a fixed-size grant hash only from canonical base64url 256-bit secrets', () => {
  const decoded = Buffer.from(operatorSecret, 'base64url');
  assert.equal(decoded.byteLength, 32);
  assert.deepEqual(
    deriveBootstrapGrantHash(operatorSecret),
    createHash('sha256').update(decoded).digest(),
  );
  assert.equal(deriveBootstrapGrantHash(`${operatorSecret}=`), null);
  assert.equal(deriveBootstrapGrantHash('not-a-bootstrap-secret'), null);
  assert.equal(deriveBootstrapGrantHash(Buffer.from(operatorSecret)), null);
  assert.equal(deriveBootstrapGrantHash(randomBytes(31).toString('base64url')), null);
});

test('requires explicit configured hash and valid trusted workspace configuration', () => {
  const repository = new FakeBootstrapRepository();
  assert.throws(() => new BootstrapService(repository, undefined as never), /explicitly configured/);
  assert.throws(() => new BootstrapService(repository, {
    expectedGrantHash: Buffer.alloc(31), workspace,
  }), /explicitly configured/);
  assert.throws(() => new BootstrapService(repository, {
    expectedGrantHash,
    workspace: { name: ' ', slug: 'Bad Slug' },
  }), /workspace configuration/);
});

test('valid matching grant passes only verified identity and trusted workspace to repository', async () => {
  const repository = new FakeBootstrapRepository();
  const service = new BootstrapService(repository, { expectedGrantHash, workspace });
  const grantHash = deriveBootstrapGrantHash(operatorSecret)!;

  assert.deepEqual(await service.bootstrap({ identity, grantHash }), {
    kind: 'created', userId: 'user-1', workspaceId: 'workspace-1',
  });
  assert.equal(repository.calls.length, 1);
  assert.deepEqual(repository.calls[0], { identity, workspace });
});

test('wrong or malformed grant fails generically before repository access', async () => {
  const repository = new FakeBootstrapRepository();
  const service = new BootstrapService(repository, { expectedGrantHash, workspace });

  assert.deepEqual(await service.bootstrap({ identity, grantHash: Buffer.alloc(32, 0xa5) }), { kind: 'unavailable' });
  assert.deepEqual(await service.bootstrap({ identity, grantHash: Buffer.alloc(31) }), { kind: 'unavailable' });
  assert.deepEqual(await service.bootstrap({ identity, grantHash: null as never }), { kind: 'unavailable' });
  assert.equal(repository.calls.length, 0);
});

test('requires canonical verified provider identity and does not email-link', async () => {
  const repository = new FakeBootstrapRepository();
  const service = new BootstrapService(repository, { expectedGrantHash, workspace });
  const grantHash = deriveBootstrapGrantHash(operatorSecret)!;

  assert.deepEqual(await service.bootstrap({
    identity: { ...identity, issuer: 'http://issuer.example/' }, grantHash,
  }), { kind: 'unavailable' });
  assert.deepEqual(await service.bootstrap({
    identity: { ...identity, subject: '' }, grantHash,
  }), { kind: 'unavailable' });
  assert.deepEqual(await service.bootstrap({
    identity: { ...identity, emailVerified: false }, grantHash,
  }), { kind: 'unavailable' });
  assert.deepEqual(await service.bootstrap({
    identity: { ...identity, email: null }, grantHash,
  }), { kind: 'unavailable' });
  assert.equal(repository.calls.length, 0);
});

test('propagates persistence failures without logging or translating secrets', async () => {
  const repository = new FakeBootstrapRepository();
  const storageFailure = new Error('database unavailable');
  repository.error = storageFailure;
  const service = new BootstrapService(repository, { expectedGrantHash, workspace });

  await assert.rejects(
    () => service.bootstrap({ identity, grantHash: deriveBootstrapGrantHash(operatorSecret)! }),
    storageFailure,
  );
});
