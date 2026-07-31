// @ts-nocheck

function pullRequestKindLabel(kind) {
  return kind === "plan" ? "Plan" : kind === "build" ? "Build" : ""
}

function pullRequestSummaryFromFact(pullRequest = {}) {
  const number = Number(pullRequest.prNumber || 0)
  const kind = String(pullRequest.kind || "")
  const state = String(pullRequest.state || "open")
  const merged = state === "merged"
  const kindLabel = pullRequestKindLabel(kind)
  return {
    id: String(pullRequest.pullRequestId || pullRequest.id || number),
    number,
    title: kindLabel ? `${kindLabel} MR #${number}` : `MR #${number}`,
    body: "",
    state,
    draft: false,
    merged,
    author: { id: "", username: "", name: "", avatarUrl: "", url: "" },
    sourceBranch: "",
    targetBranch: "",
    headSha: "",
    webUrl: String(pullRequest.htmlUrl || ""),
    labels: kind ? [`mr-by::${kind}`] : [],
    commentsCount: 0,
    commitsCount: 0,
    changedFilesCount: 0,
    additions: 0,
    deletions: 0,
    createdAt: String(pullRequest.openedAt || ""),
    updatedAt: String(pullRequest.updatedAt || ""),
    mergedAt: String(pullRequest.mergedAt || ""),
    closedAt: String(pullRequest.closedAt || ""),
    sourceIssueNumber: Number(pullRequest.issueNumber || 0),
    previewable: kind === "plan",
  }
}

async function listIssuePullRequestSummaries(store, repo, issueNumber) {
  const pullRequests = await store.listPullRequestsByIssue({
    gitServerId: repo.gitServerId,
    repositoryId: repo.serverRepoId,
    issueNumber,
  })
  return pullRequests.map(pullRequestSummaryFromFact)
}

export { listIssuePullRequestSummaries, pullRequestSummaryFromFact }
