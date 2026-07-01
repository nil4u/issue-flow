// @ts-nocheck
import crypto from 'node:crypto'

const SECRET_KEY_PATTERN = /(token|secret|api[_-]?key|authorization|private[_-]?token)/i;
const SECRET_VALUE_PATTERN = /(glpat-|gldt-|glcbt-|glrt-|github_pat_|gh[pousr]_)[A-Za-z0-9_\-]+/g;

function redactString(value) {
  return String(value || '').replace(SECRET_VALUE_PATTERN, '[redacted]');
}

function sanitize(value, depth = 0) {
  if (depth > 8) {
    return '[truncated]';
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : sanitize(item, depth + 1);
  }
  return output;
}

function compactNulls(value, depth = 0) {
  if (depth > 8) {
    return '[truncated]';
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactNulls(item, depth + 1));
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const compacted = compactNulls(item, depth + 1);
    if (compacted !== undefined) {
      output[key] = compacted;
    }
  }
  return output;
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  const status = error && typeof error.status === 'number' ? error.status : undefined;
  return {
    code: status ? `HTTP_${status}` : 'ERROR',
    message: redactString(message),
  };
}

function fingerprintSecret(value) {
  if (!value) {
    return '';
  }
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function summarizeGitlabPayload(payload = {}) {
  const attrs = payload.object_attributes || {};
  const project = payload.project || {};
  const noteableType = attrs.noteable_type || '';
  return sanitize({
    objectKind: payload.object_kind || payload.event_type || '',
    eventName: payload.event_name || payload.event_type || '',
    action: attrs.action || payload.action || '',
    projectId: project.id,
    projectPath: project.path_with_namespace,
    issueIid: (payload.issue && payload.issue.iid) || (attrs && attrs.iid && (payload.object_kind === 'issue' ? attrs.iid : undefined)),
    mergeRequestIid: (payload.merge_request && payload.merge_request.iid) || (payload.object_kind === 'merge_request' ? attrs.iid : undefined),
    noteId: payload.object_kind === 'note' ? attrs.id : undefined,
    noteableType,
    status: attrs.status || payload.build_status || '',
  });
}

export {
  compactNulls,
  fingerprintSecret,
  sanitize,
  sanitizeError,
  summarizeGitlabPayload,
}
