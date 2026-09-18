// The error envelope and its HTTP mapping (API-9). Spec: api-design.md §Errors.
import type { OpenYachtError } from "./generated";

export type ErrorCode = OpenYachtError["error"]["code"];

/** "HTTP status codes follow the obvious mapping" — api-design.md §Errors. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  SIGNATURE_INVALID: 401,
  TIMESTAMP_OUT_OF_RANGE: 401,
  PARTNER_UNKNOWN: 401,
  PARTNER_BLOCKED: 403,
  PARTNER_PROVISIONAL: 403,
  NOT_FOUND: 404,
  GONE: 410,
  RATE_LIMITED: 429,
  VALIDATION_ERROR: 422,
  VERSION_UNSUPPORTED: 400,
};

export interface ErrorEnvelopeInput {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown> | null;
  requestId: string;
  now: Date;
}

export function buildErrorEnvelope(input: ErrorEnvelopeInput): OpenYachtError {
  return {
    error: { code: input.code, message: input.message, details: input.details ?? null },
    meta: { request_id: input.requestId, time: toWireTimestamp(input.now) },
  };
}

/** RFC 3339 UTC, whole seconds: `2026-08-21T09:00:00Z` (API-1). */
export function toWireTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
