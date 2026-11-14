import type { ErrorRequestHandler, Express, RequestHandler } from 'express';
import { ApiError } from '../shared/api-error.js';

export function registerErrorHandler(app: Express): void {
  const notFound: RequestHandler = (request, response) => {
    response.status(404).json({ error: { code: 'not_found', message: 'Route not found', requestId: request.id } });
  };
  const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    if (error instanceof ApiError) {
      response.status(error.statusCode).json({ error: { code: error.code, message: error.message, requestId: request.id } });
      return;
    }
    if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.parse.failed') {
      response.status(400).json({ error: { code: 'invalid_request', message: 'Request validation failed', requestId: request.id } });
      return;
    }
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 413) {
      response.status(413).json({ error: { code: 'request_too_large', message: 'Request body is too large', requestId: request.id } });
      return;
    }
    // Database and parser errors can contain SQL parameters, cookies, or body
    // fragments. Keep the public request ID for correlation without logging them.
    console.error({ requestId: request.id }, 'request failed');
    response.status(500).json({ error: { code: 'internal_error', message: 'An unexpected error occurred', requestId: request.id } });
  };
  app.use(notFound);
  app.use(errorHandler);
}
