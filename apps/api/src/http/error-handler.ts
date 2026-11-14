import type { FastifyInstance } from 'fastify';
import { ApiError } from '../shared/api-error.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } }));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, requestId: request.id } });
    if (typeof error === 'object' && error !== null && 'validation' in error && Boolean(error.validation)) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Request validation failed', requestId: request.id } });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'An unexpected error occurred', requestId: request.id } });
  });
}
