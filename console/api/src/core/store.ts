// @ts-nocheck

import { StoreBase } from "./store/base.js"
import { withCredentialStore } from "./store/credentials.js"
import { withIdentityStore } from "./store/identity.js"
import { withIssueStore } from "./store/issues.js"
import { withMetricsStore } from "./store/metrics.js"
import { withRepositoryStore } from "./store/repositories.js"
import { normalizeApiUrl, normalizeBaseUrl, nowIso } from "./store/shared.js"
import { withTaskStore } from "./store/tasks.js"

// -----------------------------------------------------------------------------
// 领域组合：保留单一 Store API，把持久化行为按业务边界分散到独立模块。
// -----------------------------------------------------------------------------
const StoreDomains = withCredentialStore(
  withMetricsStore(
    withTaskStore(
      withIssueStore(
        withRepositoryStore(
          withIdentityStore(StoreBase),
        ),
      ),
    ),
  ),
)

class IssueFlowStore extends StoreDomains {
  constructor(options = {}) {
    super(options)
  }
}

export {
  IssueFlowStore,
  normalizeApiUrl,
  normalizeBaseUrl,
  nowIso,
}
