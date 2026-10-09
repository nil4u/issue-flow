// @ts-nocheck
import { issueSnapshotFromProviderIssue } from '../issue-projection.js'
import { issueFlowMarkers } from '../provenance-marker.js'
import { pullRequestKind } from '../pull-request-projection.js'

export function githubIssueSnapshot(repo, issue, receivedAt) {
  return issueSnapshotFromProviderIssue(repo, {
    ...issue, author: { username: issue.user?.login || '', name: issue.user?.name || '' },
    createdAt: issue.created_at || receivedAt, updatedAt: issue.updated_at || receivedAt, closedAt: issue.closed_at,
  })
}

export function githubEventFacts(record) {
  const payload = record.payload || {}
  const repo = { gitServerId: record.gitServerId, serverRepoId: record.repositoryId, fullName: record.repositoryFullName }
  const issue = record.eventName === 'issues' && payload.issue && !payload.issue.pull_request
    ? githubIssueSnapshot(repo, payload.issue, record.receivedAt) : undefined
  const pr = record.eventName === 'pull_request' ? payload.pull_request : undefined
  if (!pr) return { issue, projectSpan: Boolean(issue) }
  const markers = issueFlowMarkers(pr.body || '')
  const updatedAt = pr.updated_at || record.receivedAt
  return { issue, projectSpan: Boolean(issue), pullRequest: {
    gitServerId: repo.gitServerId, repositoryId: repo.serverRepoId, repositoryFullName: repo.fullName,
    issueNumber: markers.sourceIssueNumber, openedByTaskId: markers.taskId, sourceRuntime: markers.sourceRuntime,
    pullRequestId: String(pr.id), prNumber: pr.number, kind: pullRequestKind((pr.labels || []).map((label) => label.name)),
    state: pr.merged ? 'merged' : pr.state, htmlUrl: pr.html_url || '', openedAt: pr.created_at || updatedAt,
    mergedAt: pr.merged_at || '', closedAt: pr.closed_at || '', updatedAt,
  } }
}

export function githubPullRequestChange(payload) {
  const pr = payload.pull_request
  if (!pr || payload.action !== 'closed') return undefined
  return { iid: String(pr.number), sourceBranch: pr.head?.ref || '', targetBranch: pr.base?.ref || '', state: pr.merged ? 'merged' : 'closed' }
}
