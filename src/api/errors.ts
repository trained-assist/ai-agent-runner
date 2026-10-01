import { redactSecrets } from '../runner/util.js';

export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'SCOPE_DENIED'
  | 'ENGINE_NOT_ALLOWED'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_CONFLICT'
  | 'TASK_ATTEMPT_ACTIVE'
  | 'NOT_FOUND'
  | 'ROUTE_NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'RESULT_NOT_READY'
  | 'STALE_OWNER_GENERATION'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL';

const HTTP_STATUS: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SCOPE_DENIED: 403,
  ENGINE_NOT_ALLOWED: 403,
  MISSING_IDEMPOTENCY_KEY: 400,
  INVALID_REQUEST: 400,
  IDEMPOTENCY_CONFLICT: 409,
  TASK_ATTEMPT_ACTIVE: 409,
  NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  RESULT_NOT_READY: 409,
  STALE_OWNER_GENERATION: 409,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
};

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(redactSecrets(message));
    this.name = 'ApiError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    if (details !== undefined) this.details = details;
  }

  body(): ApiErrorBody {
    const error: ApiErrorBody['error'] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}
