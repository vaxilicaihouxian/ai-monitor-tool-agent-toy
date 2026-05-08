/**
 * Auth abstraction layer — base type definitions
 *
 * AuthProvider decouples authentication from query logic;
 * data source implementations reference AuthProvider instead of handling auth themselves.
 */

/** An authenticable request */
export interface AuthableRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  queryParams?: Record<string, string>;
  body?: string;
}

/** Auth provider interface */
export interface AuthProvider {
  /** Add authentication info to a request (headers / params etc.) */
  applyAuth(request: AuthableRequest): AuthableRequest;
}
