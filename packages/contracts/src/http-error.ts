/** Stable error envelope returned by versioned HTTP endpoints. */
export interface HttpErrorResponse {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export function httpErrorResponse(code: string, message: string, requestId: string): HttpErrorResponse {
  return { error: { code, message, requestId } };
}
