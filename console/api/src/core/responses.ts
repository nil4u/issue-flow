// @ts-nocheck
import { sanitizeError } from './sanitize.js'

function errorResponse(error) {
  const status = error && Number(error.status) >= 400 && Number(error.status) < 600
    ? Number(error.status)
    : 500;
  return {
    status,
    body: {
      error: status === 404 ? 'not_found' : status === 500 ? 'internal_error' : 'request_failed',
      detail: sanitizeError(error),
    },
  };
}

export {
  errorResponse,
}
