// @ts-nocheck
import { githubRepoPath, gitlabProjectPath, providerApiError as apiError, providerFetch, renderProviderMarkdown } from "./provider-api.js"

async function readVisualRepositoryFile(server, repo, ref, filePath) {
  if (server.type === "github") {
    const result = await providerFetch(server, "GET", `${githubRepoPath(repo)}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`)
    if (!result || result.type !== "file" || !result.content) throw apiError("visual artifact file not found", 404)
    return Buffer.from(String(result.content).replace(/\s+/g, ""), "base64")
  }
  if (server.type === "gitlab") {
    const result = await providerFetch(server, "GET", `${gitlabProjectPath(repo)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`)
    if (!result || !result.content) throw apiError("visual artifact file not found", 404)
    return Buffer.from(String(result.content).replace(/\s+/g, ""), result.encoding || "base64")
  }
  throw apiError(`unsupported git provider: ${server.type}`, 400)
}

async function listPlanMergeRequests(server, repo) {
  if (server.type === "github") {
    const result = await providerFetch(server, "GET", `${githubRepoPath(repo)}/pulls?state=all&per_page=100&sort=updated&direction=desc`)
    return (Array.isArray(result) ? result : [])
      .filter((pullRequest) => (pullRequest.labels || []).some((label) => (typeof label === "string" ? label : label.name) === "mr-by::plan"))
      .map((pullRequest) => ({
        id: String(pullRequest.id || ""), number: Number(pullRequest.number), body: pullRequest.body || "",
        title: pullRequest.title || "", state: pullRequest.merged_at ? "merged" : pullRequest.state || "",
        merged: Boolean(pullRequest.merged_at), headBranch: pullRequest.head && pullRequest.head.ref || "",
        baseBranch: pullRequest.base && pullRequest.base.ref || "", commitSha: pullRequest.head && pullRequest.head.sha || "",
        url: pullRequest.html_url || "", createdAt: pullRequest.created_at || "", updatedAt: pullRequest.updated_at || "",
      }))
  }
  if (server.type === "gitlab") {
    const result = await providerFetch(server, "GET", `${gitlabProjectPath(repo)}/merge_requests?scope=all&state=all&labels=${encodeURIComponent("mr-by::plan")}&per_page=100&order_by=updated_at&sort=desc`)
    return (Array.isArray(result) ? result : []).map((mergeRequest) => ({
      id: String(mergeRequest.id || ""), number: Number(mergeRequest.iid), body: mergeRequest.description || "",
      title: mergeRequest.title || "", state: mergeRequest.state || "", merged: mergeRequest.state === "merged",
      headBranch: mergeRequest.source_branch || "", baseBranch: mergeRequest.target_branch || "",
      commitSha: mergeRequest.sha || mergeRequest.diff_head_sha || "", url: mergeRequest.web_url || "",
      createdAt: mergeRequest.created_at || "", updatedAt: mergeRequest.updated_at || "",
    }))
  }
  throw apiError(`unsupported git provider: ${server.type}`, 400)
}

async function createPlanMergeRequestComment(server, repo, mergeRequestNumber, body) {
  if (server.type === "github") return providerFetch(server, "POST", `${githubRepoPath(repo)}/issues/${mergeRequestNumber}/comments`, { body })
  if (server.type === "gitlab") return providerFetch(server, "POST", `${gitlabProjectPath(repo)}/merge_requests/${mergeRequestNumber}/notes`, { body })
  throw apiError(`unsupported git provider: ${server.type}`, 400)
}

async function applyVisualIssueLabels(server, repo, issueNumber, desired = {}) {
  const prefixes = Object.keys(desired)
  if (server.type === "github") {
    const issue = await providerFetch(server, "GET", `${githubRepoPath(repo)}/issues/${issueNumber}`)
    const labels = (issue.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean)
    const next = labels.filter((label) => !prefixes.some((prefix) => label.startsWith(prefix)))
    for (const label of Object.values(desired)) if (label) next.push(label)
    return providerFetch(server, "PATCH", `${githubRepoPath(repo)}/issues/${issueNumber}`, { labels: [...new Set(next)] })
  }
  if (server.type === "gitlab") {
    const issue = await providerFetch(server, "GET", `${gitlabProjectPath(repo)}/issues/${issueNumber}`)
    const next = (Array.isArray(issue.labels) ? issue.labels : []).filter((label) => !prefixes.some((prefix) => label.startsWith(prefix)))
    for (const label of Object.values(desired)) if (label) next.push(label)
    return providerFetch(server, "PUT", `${gitlabProjectPath(repo)}/issues/${issueNumber}`, { labels: [...new Set(next)].join(",") })
  }
  throw apiError(`unsupported git provider: ${server.type}`, 400)
}

async function readVisualIssueLabels(server, repo, issueNumber) {
  const issue = server.type === "github"
    ? await providerFetch(server, "GET", `${githubRepoPath(repo)}/issues/${issueNumber}`)
    : server.type === "gitlab"
      ? await providerFetch(server, "GET", `${gitlabProjectPath(repo)}/issues/${issueNumber}`)
      : undefined
  if (!issue) throw apiError(`unsupported git provider: ${server.type}`, 400)
  return (Array.isArray(issue.labels) ? issue.labels : [])
    .map((label) => typeof label === "string" ? label : label && label.name)
    .filter(Boolean)
}

async function mergePlanMergeRequest(server, repo, mergeRequestNumber) {
  if (server.type === "github") {
    const result = await providerFetch(server, "PUT", `${githubRepoPath(repo)}/pulls/${mergeRequestNumber}/merge`, { merge_method: "merge" })
    if (!result || result.merged !== true) throw apiError("pull request could not be merged", 409, result)
    return result
  }
  if (server.type === "gitlab") {
    const result = await providerFetch(server, "PUT", `${gitlabProjectPath(repo)}/merge_requests/${mergeRequestNumber}/merge`, { should_remove_source_branch: true, squash: false })
    if (!result || result.state !== "merged") throw apiError("merge request could not be merged", 409, result)
    return result
  }
  throw apiError(`unsupported git provider: ${server.type}`, 400)
}

async function renderPlanMarkdown(server, repo, markdown) {
  return renderProviderMarkdown(server, repo, markdown)
}

export { applyVisualIssueLabels, createPlanMergeRequestComment, listPlanMergeRequests, mergePlanMergeRequest, readVisualIssueLabels, readVisualRepositoryFile, renderPlanMarkdown }
