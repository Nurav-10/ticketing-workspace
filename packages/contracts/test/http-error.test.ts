import { expect, test } from 'bun:test';
import { httpErrorResponse } from '../src/http-error.js';

test('HTTP errors have one stable, request-correlated envelope', () => {
  expect(httpErrorResponse('not_found', 'Route not found', 'req-123')).toEqual({
    error: {
      code: 'not_found',
      message: 'Route not found',
      requestId: 'req-123',
    },
  });
});
