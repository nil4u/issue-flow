// @ts-nocheck
import path from "node:path"

import { applyVisualIssueLabels, createPlanMergeRequestComment, listPlanMergeRequests, mergePlanMergeRequest, readVisualRepositoryFile, renderPlanMarkdown } from "./visual-provider.js"

const ARTIFACT_TYPES = new Set(["decision", "plan"])
const MARKER_PATTERN = /<!--\s*issue-flow:plan-artifact\s+artifact=(decision|plan)\s+format=(html|markdown)\s+repo=([^\s]+)\s+issue=(\d+)\s+branch=([^\s]+)\s+commit=([^\s]+)\s+path=([^\s]+)\s*-->/i

function requestError(message, status = 400, code = "visual_artifact_error") {
  const error = new Error(message); error.status = status; error.code = code; return error
}
function normalizeArtifactType(value) {
  const type = String(value || "").trim().toLowerCase()
  if (!ARTIFACT_TYPES.has(type)) throw requestError("artifact type must be decision or plan")
  return type
}
function normalizeIssueNumber(value) {
  const issueNumber = Number.parseInt(String(value || ""), 10)
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) throw requestError("issue number must be positive")
  return issueNumber
}
function normalizeRepoPath(value) {
  const normalized = path.posix.normalize(String(value || "").replace(/\\/g, "/").replace(/^\/+/, ""))
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw requestError("invalid visual artifact path")
  return normalized
}

function parseArtifactMarker(mergeRequest = {}) {
  const match = String(mergeRequest.body || "").match(MARKER_PATTERN)
  if (!match) return undefined
  return {
    type: match[1].toLowerCase(), format: match[2].toLowerCase(), repositoryId: decodeURIComponent(match[3]), issueNumber: Number.parseInt(match[4], 10),
    branch: match[5], commitSha: match[6], entryPath: normalizeRepoPath(match[7]),
    mergeRequestId: String(mergeRequest.id || ""), mergeRequestNumber: Number(mergeRequest.number), mergeRequestUrl: mergeRequest.url || "",
    mergeRequestState: mergeRequest.state || "", merged: Boolean(mergeRequest.merged), baseBranch: mergeRequest.baseBranch || "",
    publishedAt: mergeRequest.updatedAt || mergeRequest.createdAt || new Date().toISOString(),
  }
}

async function requireVisualContext(store, gitServerId, projectId, userId, session) {
  if (!userId) throw requestError("login required", 401, "login_required")
  if (!session || !session.token || session.userId !== userId || session.gitServerId !== gitServerId) throw requestError("current Git credential is required", 401, "git_credential_required")
  const repo = await store.findRepositoryByProject({ gitServerId, projectId })
  if (!repo || !await store.userCanAccessRepo(userId, repo.id)) throw requestError("repository not found", 404, "repository_not_found")
  const server = await store.getGitServer(repo.gitServerId, { includeSecret: true })
  if (!server) throw requestError("git server not found", 404, "git_server_not_found")
  return { repo, server: { ...server, userToken: session.token } }
}

async function discoverVisualArtifact(store, repo, server, issueNumber, type) {
  const mergeRequests = await listPlanMergeRequests(server, repo)
  const marker = mergeRequests.map(parseArtifactMarker)
    .filter((item) => item && item.type === type && item.repositoryId === repo.id && item.issueNumber === issueNumber)
    .sort((left, right) => {
      const stateRank = (item) => item.mergeRequestState === "opened" || item.mergeRequestState === "open" ? 2 : item.merged ? 1 : 0
      return stateRank(right) - stateRank(left) || String(right.publishedAt).localeCompare(String(left.publishedAt))
    })[0]
  if (!marker) throw requestError(`${type} MR has not been published`, 404, "plan_artifact_not_published")
  return marker
}

async function listReviewablePlanArtifacts({ store, gitServerId, projectId, userId, session }) {
  const { repo, server } = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const artifacts = (await listPlanMergeRequests(server, repo))
    .map(parseArtifactMarker)
    .filter((item) => item
      && item.repositoryId === repo.id
      && !item.merged
      && (item.mergeRequestState === "open" || item.mergeRequestState === "opened"))
    .sort((left, right) => String(right.publishedAt).localeCompare(String(left.publishedAt)))
  const seen = new Set()
  return artifacts.filter((artifact) => {
    const key = `${artifact.issueNumber}:${artifact.type}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map((artifact) => ({
    issueNumber: artifact.issueNumber,
    type: artifact.type,
    format: artifact.format,
    mergeRequestNumber: artifact.mergeRequestNumber,
  }))
}

async function resolveVisualArtifact(store, repo, server, issueNumber, type) {
  const stored = await store.getVisualArtifact(repo.id, issueNumber, type)
  const marker = await discoverVisualArtifact(store, repo, server, issueNumber, type)
  const unchanged = stored && stored.commitSha === marker.commitSha && stored.data && stored.data.mergeRequestNumber === marker.mergeRequestNumber
  const merged = marker.merged || marker.mergeRequestState === "merged"
  return store.upsertVisualArtifact({
    repoId: repo.id, issueNumber, type, branch: marker.branch, baseBranch: marker.baseBranch || repo.defaultBranch || "main",
    commitSha: marker.commitSha, entryPath: marker.entryPath,
    status: merged ? "approved" : unchanged ? stored.status : "pending", approvedAt: merged ? stored && stored.approvedAt || marker.publishedAt : unchanged ? stored.approvedAt : null,
    providerCommentId: String(marker.mergeRequestNumber || ""), publishedAt: marker.publishedAt,
    data: { ...(unchanged ? stored.data || {} : {}), ...marker },
  })
}

function contentTypeFor(filePath) {
  const ext = path.posix.extname(filePath).toLowerCase()
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" })[ext] || "application/octet-stream"
}
function isExternalResource(value) { return /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(String(value || "").trim()) }
function artifactFileUrl(gitServerId, projectId, issueNumber, type, relativePath) { return `/api/visual-artifacts/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/${issueNumber}/${type}/file?path=${encodeURIComponent(relativePath)}` }
function resolveRelativePath(currentPath, resourcePath) {
  const match = String(resourcePath || "").trim().match(/^([^?#]*)(.*)$/)
  return { path: normalizeRepoPath(path.posix.join(path.posix.dirname(currentPath), match[1])), suffix: match[2] || "" }
}
function rewriteHtmlResources(html, gitServerId, projectId, issueNumber, type, currentPath) {
  return String(html).replace(/\b(href|src|poster)=(["'])([^"']+)\2/gi, (full, attribute, quote, value) => {
    if (isExternalResource(value)) return full
    const resolved = resolveRelativePath(currentPath, value)
    return `${attribute}=${quote}${artifactFileUrl(gitServerId, projectId, issueNumber, type, resolved.path)}${resolved.suffix}${quote}`
  })
}
function rewriteCssResources(css, gitServerId, projectId, issueNumber, type, currentPath) {
  return String(css).replace(/url\((["']?)(?![a-z][a-z0-9+.-]*:|#|\/)([^"')]+)\1\)/gi, (_full, _quote, value) => {
    const resolved = resolveRelativePath(currentPath, value)
    return `url("${artifactFileUrl(gitServerId, projectId, issueNumber, type, resolved.path)}${resolved.suffix}")`
  })
}

async function readArtifactFile(server, repo, artifact, requestedPath = "") {
  const repoPath = normalizeRepoPath(requestedPath || artifact.entryPath)
  const bytes = await readVisualRepositoryFile(server, repo, artifact.commitSha, repoPath)
  const contentType = contentTypeFor(repoPath)
  if (contentType.startsWith("text/html")) return { body: rewriteHtmlResources(bytes.toString("utf8"), repo.gitServerId, repo.serverRepoId, artifact.issueNumber, artifact.type, repoPath), contentType }
  if (contentType.startsWith("text/css")) return { body: rewriteCssResources(bytes.toString("utf8"), repo.gitServerId, repo.serverRepoId, artifact.issueNumber, artifact.type, repoPath), contentType }
  return { body: bytes, contentType }
}

function markdownDocument(renderedHtml, artifact) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{color:#18181b;background:#fff;font:15px/1.7 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}body{margin:0;padding:32px}article{max-width:920px;margin:0 auto}h1,h2,h3{line-height:1.3;margin:1.6em 0 .6em}h1{font-size:30px;border-bottom:1px solid #e4e4e7;padding-bottom:12px}h2{font-size:23px}h3{font-size:18px}p,ul,ol,pre,table,blockquote{margin:1em 0}pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}code{background:#f4f4f5;border-radius:4px;padding:.15em .35em}pre{overflow:auto;background:#18181b;color:#fafafa;border-radius:8px;padding:16px}pre code{background:none;padding:0}table{width:100%;border-collapse:collapse}th,td{border:1px solid #e4e4e7;padding:8px 10px;text-align:left}blockquote{margin-left:0;border-left:4px solid #d4d4d8;padding-left:16px;color:#52525b}a{color:#2563eb}img{max-width:100%}
  </style></head><body><article data-comment-scope="section" data-comment-label="Markdown Plan" data-ref="markdown.${artifact.type}">${renderedHtml}</article></body></html>`
}

async function getVisualArtifact({ store, gitServerId, projectId, issueNumber: rawIssueNumber, type: rawType, userId, session }) {
  const issueNumber = normalizeIssueNumber(rawIssueNumber); const type = normalizeArtifactType(rawType)
  const { repo, server } = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const artifact = await resolveVisualArtifact(store, repo, server, issueNumber, type)
  const entry = await readArtifactFile(server, repo, artifact)
  const format = artifact.data && artifact.data.format || "html"
  const html = format === "markdown"
    ? markdownDocument(await renderPlanMarkdown(server, repo, String(entry.body)), artifact)
    : String(entry.body)
  return {
    artifact, format,
    mergeRequest: {
      id: artifact.data && artifact.data.mergeRequestId || "", number: artifact.data && artifact.data.mergeRequestNumber || 0,
      url: artifact.data && artifact.data.mergeRequestUrl || "", state: artifact.data && artifact.data.mergeRequestState || "",
    },
    repository: { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch, provider: server.type },
    html, drafts: await store.listVisualReviewDrafts(artifact.id, userId), reviews: await store.listVisualReviews(artifact.id),
  }
}
async function getVisualArtifactFile({ store, gitServerId, projectId, issueNumber, type, requestedPath, userId, session }) {
  const context = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const artifact = await resolveVisualArtifact(store, context.repo, context.server, normalizeIssueNumber(issueNumber), normalizeArtifactType(type))
  return readArtifactFile(context.server, context.repo, artifact, requestedPath)
}
async function createVisualDraft({ store, gitServerId, projectId, issueNumber, type, userId, session, input }) {
  const loaded = await getVisualArtifact({ store, gitServerId, projectId, issueNumber, type, userId, session }); return store.createVisualReviewDraft(loaded.artifact.id, userId, input || {})
}
async function updateVisualDraft({ store, gitServerId, projectId, issueNumber, type, draftId, userId, session, input }) {
  const loaded = await getVisualArtifact({ store, gitServerId, projectId, issueNumber, type, userId, session }); const result = await store.updateVisualReviewDraft(draftId, loaded.artifact.id, userId, input || {}); if (!result) throw requestError("review draft not found", 404); return result
}
async function deleteVisualDraft({ store, gitServerId, projectId, issueNumber, type, draftId, userId, session }) {
  const loaded = await getVisualArtifact({ store, gitServerId, projectId, issueNumber, type, userId, session }); if (!await store.deleteVisualReviewDraft(draftId, loaded.artifact.id, userId)) throw requestError("review draft not found", 404); return { deleted: true, id: draftId }
}

function compactReviewText(value, maxLength = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}
function elementTextFromHtml(html) {
  return compactReviewText(String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"))
}
function inlineCode(value) { return String(value || "").replace(/`/g, "'") }
function reviewItemLines(items = []) {
  return items.flatMap((item, index) => {
    const decision = item.decision
    const comment = compactReviewText(item.comment) || "没有附加评论"
    if (decision) {
      const action = decision.action === "approve" ? "通过决策" : "讨论决策"
      return [`${index + 1}. **${action} \`${inlineCode(decision.ref)}\`** — ${comment}`]
    }
    const visualTarget = item.visualTarget || {}
    const element = visualTarget.element || (Array.isArray(visualTarget.elements) ? visualTarget.elements[0] : undefined) || {}
    const artifactPath = visualTarget.path || item.sourceRefs && item.sourceRefs[0] && item.sourceRefs[0].path || item.targetId || ""
    const anchor = visualTarget.anchorRef || element.dataRef || visualTarget.anchorSelector || element.selector || ""
    const pageContent = element.ariaLabel || elementTextFromHtml(element.html)
    const lines = [`${index + 1}. **${comment}**`]
    if (artifactPath) lines.push(`   - 产物：\`${inlineCode(artifactPath)}\``)
    if (anchor) lines.push(`   - 锚点：\`${inlineCode(anchor)}\``)
    if (pageContent) lines.push(`   - 页面内容：${pageContent}`)
    return lines
  })
}
function buildReviewComment(artifact, review, status) {
  const title = artifact.type === "decision" ? "Decision Review" : artifact.data && artifact.data.format === "markdown" ? "Markdown Plan Review" : "Visual Plan Review"
  const shouldResumePlanTask = status === "changes-requested"
  const artifactName = artifact.type === "decision" ? "Decision" : "Plan"
  return [
    `<!-- issue-flow:visual-review artifact=${artifact.type} review=${review.id} status=${status} -->`,
    `## ${title}`,
    "",
    `Status: **${status}**`,
    "",
    ...reviewItemLines(review.payload && review.payload.items || []),
    ...(shouldResumePlanTask ? ["", `请根据以上审阅意见更新当前 ${artifactName} 产物。`] : []),
  ].join("\n")
}
async function decisionRefs(server, repo, artifact) {
  try {
    const decisionPath = normalizeRepoPath(path.posix.join(path.posix.dirname(artifact.entryPath), "decision/data/decision-data.json"))
    const data = JSON.parse((await readVisualRepositoryFile(server, repo, artifact.commitSha, decisionPath)).toString("utf8"))
    return Array.isArray(data.decisions) ? data.decisions.filter((item) => item && item.id).map((item) => `decisions.${item.id}`) : []
  } catch { return [] }
}

function pendingDecisionApprovalRefs(requiredRefs, drafts) {
  const reviewedRefs = new Set((drafts || [])
    .filter((item) => item && item.decision && item.decision.ref)
    .map((item) => item.decision.ref))
  return (requiredRefs || []).filter((ref) => !reviewedRefs.has(ref))
}

async function submitVisualReview({ store, gitServerId, projectId, issueNumber, type, userId, session, input = {} }) {
  const { repo, server } = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const artifact = await resolveVisualArtifact(store, repo, server, normalizeIssueNumber(issueNumber), normalizeArtifactType(type))
  let drafts = await store.listVisualReviewDrafts(artifact.id, userId)
  if (artifact.type === "decision" && input.approveAll === true) {
    const requiredRefs = await decisionRefs(server, repo, artifact)
    if (!requiredRefs.length) throw requestError("decision artifact has no reviewable decisions")
    for (const ref of pendingDecisionApprovalRefs(requiredRefs, drafts)) {
      await store.createVisualReviewDraft(artifact.id, userId, {
        targetType: "artifact", targetId: ref,
        sourceRefs: [{ type: "decision", path: artifact.entryPath, label: "决策" }],
        decision: { action: "approve", ref, id: ref.replace(/^decisions\./, "") },
        comment: `通过决策：${ref}`, severity: "note", intent: "refinement",
      })
    }
    drafts = await store.listVisualReviewDrafts(artifact.id, userId)
  }
  if (!drafts.length) throw requestError("no review drafts to submit")
  let status = "changes-requested"
  if (artifact.type === "decision") {
    const requiredRefs = await decisionRefs(server, repo, artifact)
    const approvedRefs = new Set(drafts.filter((item) => item.decision && item.decision.action === "approve").map((item) => item.decision.ref))
    const discussed = drafts.some((item) => item.decision && item.decision.action === "discuss")
    status = !discussed && requiredRefs.length > 0 && requiredRefs.every((ref) => approvedRefs.has(ref)) ? "approved" : "changes-requested"
  }
  if (artifact.type === "decision" && status === "approved") {
    const merge = await mergePlanMergeRequest(server, repo, artifact.data && artifact.data.mergeRequestNumber)
    const review = await store.submitVisualReview(artifact.id, userId, { ...input, kind: artifact.type, status, merge })
    await createPlanMergeRequestComment(server, repo, artifact.data && artifact.data.mergeRequestNumber, buildReviewComment(artifact, review, status))
    await store.updateVisualArtifact(artifact.id, { status, approvedAt: new Date().toISOString(), data: { ...(artifact.data || {}), merge, mergeRequestState: "merged", merged: true } })
    await applyVisualIssueLabels(server, repo, artifact.issueNumber, { "decision::": "decision::approved", "flow::": "flow::plan" })
    return { review, status, merge, flow: "flow::plan" }
  }
  const review = await store.submitVisualReview(artifact.id, userId, { ...input, kind: artifact.type, status })
  const providerComment = await createPlanMergeRequestComment(server, repo, artifact.data && artifact.data.mergeRequestNumber, buildReviewComment(artifact, review, status))
  await store.updateVisualArtifact(artifact.id, { status, approvedAt: null, data: { ...(artifact.data || {}), lastReviewComment: providerComment } })
  if (artifact.data && artifact.data.format === "html") {
    await applyVisualIssueLabels(server, repo, artifact.issueNumber, artifact.type === "decision"
      ? { "decision::": "decision::changes-requested", "flow::": "flow::approve" }
      : { "visual-plan::": "visual-plan::changes-requested", "flow::": "flow::approve" })
  }
  return { review, status, providerComment, flow: "flow::approve" }
}

async function approveVisualPlan({ store, gitServerId, projectId, issueNumber, userId, session }) {
  const { repo, server } = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const artifact = await resolveVisualArtifact(store, repo, server, normalizeIssueNumber(issueNumber), "plan")
  let merge
  try {
    merge = await mergePlanMergeRequest(server, repo, artifact.data && artifact.data.mergeRequestNumber)
  } catch (error) {
    await store.updateVisualArtifact(artifact.id, { status: "pending", approvedAt: null })
    throw error
  }
  const review = await store.submitVisualReview(artifact.id, userId, { kind: "approval", status: "approved", merge })
  await createPlanMergeRequestComment(server, repo, artifact.data && artifact.data.mergeRequestNumber, buildReviewComment(artifact, review, "approved"))
  await store.updateVisualArtifact(artifact.id, { status: "approved", approvedAt: new Date().toISOString(), data: { ...(artifact.data || {}), merge, mergeRequestState: "merged", merged: true } })
  await applyVisualIssueLabels(server, repo, artifact.issueNumber, artifact.data && artifact.data.format === "html"
    ? { "visual-plan::": "visual-plan::approved", "flow::": "flow::build" }
    : { "flow::": "flow::build" })
  return { artifact: { ...artifact, status: "approved" }, review, merge, flow: "flow::build" }
}

export { approveVisualPlan, buildReviewComment, createVisualDraft, deleteVisualDraft, getVisualArtifact, getVisualArtifactFile, listReviewablePlanArtifacts, parseArtifactMarker, pendingDecisionApprovalRefs, rewriteHtmlResources, submitVisualReview, updateVisualDraft }
