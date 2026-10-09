// @ts-nocheck



function installStep(id, kind, label, status, detail = '', extra = {}) {
  return {
    id,
    kind,
    label,
    status,
    detail,
    ...extra,
  };
}

function statusFromBoolean(ok, missingDetail, readyDetail = '') {
  return ok
    ? { status: 'passed', detail: readyDetail }
    : { status: 'needs_action', detail: missingDetail };
}

export { installStep, statusFromBoolean }
