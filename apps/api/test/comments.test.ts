import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import {
  CommentDomainError,
  validateCommentInput,
  validateCommentList,
  validateCommentMutation,
} from '../src/comments/comment-domain.js';
import { CommentApplicationService } from '../src/comments/comment-service.js';
import type { CommentRepository, IssueComment } from '../src/comments/comment-repository.js';
import { registerCommentRoutes } from '../src/comments/comment-routes.js';
import { registerErrorHandler } from '../src/http/error-handler.js';

const workspaceId = '8bb8e0ee-238c-4ba5-89ba-0f4e852861af';
const teamId = 'f43515d2-0fd8-46f7-a3a4-4f1d3bc70f0a';
const issueId = '24fba2dd-8131-4c53-a8b4-07ab988da002';
const commentId = '10fba2dd-8131-4c53-a8b4-07ab988da010';
const actorId = '49a03ed2-7eb3-4c00-a8e1-519c70306427';
const principal = { userId: actorId, sessionId: 'session-1' };

const sampleComment: IssueComment = {
  id: commentId,
  workspaceId,
  teamId,
  issueId,
  authorUserId: actorId,
  authorDisplayName: 'Test Author',
  body: 'Initial comment',
  format: 'plain_text',
  version: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  editedAt: null,
  deletedAt: null,
};

test('comment input normalizes text and fixes the format to plain text', () => {
  assert.deepEqual(validateCommentInput({ workspaceId, teamId, issueId, body: '  Please retry.  ' }), {
    workspaceId, teamId, issueId, body: 'Please retry.', format: 'plain_text',
  });
  assert.throws(() => validateCommentInput({ workspaceId, teamId, issueId, body: '  ' }), CommentDomainError);
  assert.throws(() => validateCommentInput({ workspaceId, teamId, issueId, body: 'x'.repeat(10_001) }), CommentDomainError);
  assert.throws(() => validateCommentInput({ workspaceId, teamId, issueId: 'not-uuid', body: 'text' }), CommentDomainError);
});

test('comment mutation requires a valid scoped ID and positive expected version', () => {
  assert.throws(() => validateCommentMutation({ workspaceId, teamId, issueId, commentId, expectedVersion: 0 }), CommentDomainError);
  assert.throws(() => validateCommentMutation({ workspaceId, teamId, issueId, commentId, expectedVersion: -1 }), CommentDomainError);
  assert.throws(() => validateCommentMutation({ workspaceId, teamId, issueId, commentId: 'bad', expectedVersion: 1 }), CommentDomainError);
  assert.deepEqual(validateCommentMutation({ workspaceId, teamId, issueId, commentId, expectedVersion: 4 }), {
    workspaceId, teamId, issueId, commentId, expectedVersion: 4,
  });
});

test('validateCommentList enforces limit bounds, cursor string, and scoped UUIDs', () => {
  assert.deepEqual(validateCommentList({ workspaceId, teamId, issueId }), {
    workspaceId, teamId, issueId, limit: 50,
  });
  assert.deepEqual(validateCommentList({ workspaceId, teamId, issueId, limit: 10, cursor: 'abc' }), {
    workspaceId, teamId, issueId, limit: 10, cursor: 'abc',
  });
  assert.throws(() => validateCommentList({ workspaceId, teamId, issueId, limit: 0 }), CommentDomainError);
  assert.throws(() => validateCommentList({ workspaceId, teamId, issueId, limit: 101 }), CommentDomainError);
  assert.throws(() => validateCommentList({ workspaceId, teamId, issueId, cursor: '' }), CommentDomainError);
  assert.throws(() => validateCommentList({ workspaceId, teamId, issueId, cursor: 'x'.repeat(513) }), CommentDomainError);
});

test('service derives the comment author from the authenticated principal across operations', async () => {
  const captured: Record<string, unknown> = {};
  const repository: CommentRepository = {
    listAuthorized: async (input) => { captured.list = input; return { items: [sampleComment] }; },
    createAuthorized: async (input) => { captured.create = input; return sampleComment; },
    updateAuthorized: async (input) => { captured.update = input; return { ...sampleComment, version: 2, body: input.body }; },
    deleteAuthorized: async (input) => { captured.delete = input; return { ...sampleComment, version: 2, body: null, deletedAt: new Date() }; },
  };
  const service = new CommentApplicationService(repository);

  await service.createForPrincipal(principal, { workspaceId, teamId, issueId, body: '  Hello world  ' });
  assert.deepEqual(captured.create, { workspaceId, teamId, issueId, body: 'Hello world', format: 'plain_text', actorUserId: actorId });

  await service.listForPrincipal(principal, { workspaceId, teamId, issueId, limit: 20 });
  assert.deepEqual(captured.list, { workspaceId, teamId, issueId, limit: 20, actorUserId: actorId });

  await service.updateForPrincipal(principal, { workspaceId, teamId, issueId, commentId, expectedVersion: 1, body: '  Updated  ' });
  assert.deepEqual(captured.update, { workspaceId, teamId, issueId, commentId, expectedVersion: 1, body: 'Updated', actorUserId: actorId });

  await service.deleteForPrincipal(principal, { workspaceId, teamId, issueId, commentId, expectedVersion: 2 });
  assert.deepEqual(captured.delete, { workspaceId, teamId, issueId, commentId, expectedVersion: 2, actorUserId: actorId });

  assert.throws(() => service.createForPrincipal({ userId: 'bad', sessionId: 'session-2' }, { workspaceId, teamId, issueId, body: 'Hello' }),
    (error: unknown) => error instanceof CommentDomainError && error.code === 'comment_forbidden');
  assert.throws(() => service.listForPrincipal({ userId: 'bad', sessionId: 'session-2' }, { workspaceId, teamId, issueId }),
    (error: unknown) => error instanceof CommentDomainError && error.code === 'comment_forbidden');
});

test('comment HTTP routes enforce auth, strong ETags, strict bodies, and domain error mapping', async () => {
  let lastAction = '';
  const service = {
    listForPrincipal: async (_p: unknown, q: unknown) => { lastAction = 'list'; return { items: [sampleComment] }; },
    createForPrincipal: async (_p: unknown, input: { body: string }) => {
      lastAction = 'create';
      return { ...sampleComment, body: input.body, version: 1 };
    },
    updateForPrincipal: async (_p: unknown, input: { expectedVersion: number; body: string }) => {
      lastAction = 'update';
      if (input.expectedVersion === 99) throw new CommentDomainError('comment_version_conflict', 'Conflict');
      if (input.expectedVersion === 88) throw new CommentDomainError('comment_forbidden', 'Forbidden');
      if (input.expectedVersion === 77) throw new CommentDomainError('comment_not_found', 'Not found');
      return { ...sampleComment, body: input.body, version: input.expectedVersion + 1 };
    },
    deleteForPrincipal: async (_p: unknown, input: { expectedVersion: number }) => {
      lastAction = 'delete';
      if (input.expectedVersion === 99) throw new CommentDomainError('comment_version_conflict', 'Conflict');
      return { ...sampleComment, body: null, deletedAt: new Date(), version: input.expectedVersion + 1 };
    },
  };

  const app = express();
  app.use(express.json());
  let authenticated = true;
  app.use((request, _response, next) => {
    request.id = 'comments-http-test';
    if (authenticated) {
      request.principal = { userId: actorId, sessionId: 'session-1' };
    }
    next();
  });
  const router = express.Router();
  registerCommentRoutes(router, service as unknown as CommentApplicationService);
  app.use('/api/v1', router);
  registerErrorHandler(app);

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workspaces/${workspaceId}/teams/${teamId}/issues/${issueId}/comments`;

  try {
    // 1. Unauthenticated request rejected
    authenticated = false;
    const unauth = await fetch(root);
    assert.equal(unauth.status, 401);
    authenticated = true;

    // 2. GET listing with Cache-Control: no-store
    const listRes = await fetch(root);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.headers.get('cache-control'), 'no-store');
    const listBody = await listRes.json() as { data: { items: IssueComment[] } };
    assert.equal(listBody.data.items.length, 1);
    assert.equal(listBody.data.items[0].id, commentId);

    // 3. GET with invalid query rejected
    const badQuery = await fetch(`${root}?unknown=1`);
    assert.equal(badQuery.status, 400);

    // 4. POST with injected field rejected
    const injected = await fetch(root, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Valid body', actorUserId: 'injected' }),
    });
    assert.equal(injected.status, 400);

    // 5. POST valid comment returns 201 and strong ETag
    const created = await fetch(root, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Hello world' }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('etag'), '"1"');
    assert.equal(created.headers.get('cache-control'), 'no-store');

    // 6. PATCH with weak ETag rejected
    const weakPatch = await fetch(`${root}/${commentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': 'W/"1"' },
      body: JSON.stringify({ body: 'New text' }),
    });
    assert.equal(weakPatch.status, 400);

    // 7. PATCH with strong ETag succeeds
    const patchOk = await fetch(`${root}/${commentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '"1"' },
      body: JSON.stringify({ body: 'New text' }),
    });
    assert.equal(patchOk.status, 200);
    assert.equal(patchOk.headers.get('etag'), '"2"');

    // 8. PATCH version conflict maps to 409
    const conflictPatch = await fetch(`${root}/${commentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '"99"' },
      body: JSON.stringify({ body: 'New text' }),
    });
    assert.equal(conflictPatch.status, 409);

    // 9. PATCH forbidden maps to 403
    const forbiddenPatch = await fetch(`${root}/${commentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '"88"' },
      body: JSON.stringify({ body: 'New text' }),
    });
    assert.equal(forbiddenPatch.status, 403);

    // 10. PATCH not found maps to 404
    const notFoundPatch = await fetch(`${root}/${commentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '"77"' },
      body: JSON.stringify({ body: 'New text' }),
    });
    assert.equal(notFoundPatch.status, 404);

    // 11. DELETE with If-Match succeeds and returns soft-deleted record
    const deleteOk = await fetch(`${root}/${commentId}`, {
      method: 'DELETE',
      headers: { 'if-match': '"2"' },
    });
    assert.equal(deleteOk.status, 200);
    assert.equal(deleteOk.headers.get('etag'), '"3"');
    const deleteBody = await deleteOk.json() as { data: IssueComment };
    assert.equal(deleteBody.data.body, null);
    assert.ok(deleteBody.data.deletedAt);

    // 12. DELETE conflict maps to 409
    const conflictDelete = await fetch(`${root}/${commentId}`, {
      method: 'DELETE',
      headers: { 'if-match': '"99"' },
    });
    assert.equal(conflictDelete.status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
