// @ts-nocheck
import crypto from "node:crypto"
import path from "node:path"

import { applyVisualIssueLabels, createPlanMergeRequestComment, listPlanMergeRequests, mergePlanMergeRequest, readVisualIssueLabels, readVisualRepositoryFile, renderPlanMarkdown } from "./visual-provider.js"
import { renderVisualArtifactDocument } from "./visual-renderer.js"

const MARKER_PATTERN = /<!--\s*issue-flow:plan-artifact\s+artifact=(decision|plan)\s+format=(json|markdown)\s+repo=([^\s]+)\s+issue=(\d+)\s+branch=([^\s]+)\s+commit=([^\s]+)\s+path=([^\s]+)\s*-->/i

function requestError(message, status = 400, code = "visual_artifact_error") {
  const error = new Error(message); error.status = status; error.code = code; return error
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
    .filter((item) => item && (!type || item.type === type) && item.repositoryId === repo.id && item.issueNumber === issueNumber)
    .sort((left, right) => {
      const stateRank = (item) => item.mergeRequestState === "opened" || item.mergeRequestState === "open" ? 2 : item.merged ? 1 : 0
      return stateRank(right) - stateRank(left) || String(right.publishedAt).localeCompare(String(left.publishedAt))
    })[0]
  if (!marker) throw requestError(type ? `${type} MR has not been published` : "Plan MR has not been published", 404, "plan_artifact_not_published")
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
    const key = String(artifact.issueNumber)
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
  const marker = await discoverVisualArtifact(store, repo, server, issueNumber, type)
  const merged = marker.merged || marker.mergeRequestState === "merged"
  return {
    id: `${repo.id}:${issueNumber}:${marker.type}`,
    repoId: repo.id,
    issueNumber,
    type: marker.type,
    branch: marker.branch,
    baseBranch: marker.baseBranch || repo.defaultBranch || "main",
    commitSha: marker.commitSha,
    entryPath: marker.entryPath,
    status: merged ? "approved" : "pending",
    providerCommentId: String(marker.mergeRequestNumber || ""),
    publishedAt: marker.publishedAt,
    approvedAt: merged ? marker.publishedAt : null,
    createdAt: marker.publishedAt,
    updatedAt: marker.publishedAt,
    data: marker,
  }
}

async function readArtifactFile(server, repo, artifact) {
  const bytes = await readVisualRepositoryFile(server, repo, artifact.commitSha, artifact.entryPath)
  return { body: bytes }
}

function markdownDocument(renderedHtml, artifact) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{color:#18181b;background:#fff;font:15px/1.7 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}body{margin:0;padding:32px}article{max-width:920px;margin:0 auto}h1,h2,h3{line-height:1.3;margin:1.6em 0 .6em}h1{font-size:30px;border-bottom:1px solid #e4e4e7;padding-bottom:12px}h2{font-size:23px}h3{font-size:18px}p,ul,ol,pre,table,blockquote{margin:1em 0}pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}code{background:#f4f4f5;border-radius:4px;padding:.15em .35em}pre{overflow:auto;background:#18181b;color:#fafafa;border-radius:8px;padding:16px}pre code{background:none;padding:0}table{width:100%;border-collapse:collapse}th,td{border:1px solid #e4e4e7;padding:8px 10px;text-align:left}blockquote{margin-left:0;border-left:4px solid #d4d4d8;padding-left:16px;color:#52525b}a{color:#2563eb}img{max-width:100%}
  </style></head><body><article data-comment-scope="section" data-comment-label="Markdown Plan" data-ref="markdown.${artifact.type}">${renderedHtml}</article></body></html>`
}

function parseVisualArtifactJson(body) {
  try {
    return JSON.parse(String(body))
  } catch (error) {
    throw requestError(`invalid visual artifact JSON: ${error.message}`, 422)
  }
}

function customHtmlFiles(data) {
  const files = (Array.isArray(data && data.sections) ? data.sections : [])
    .filter((section) => section && section.type === "custom-html")
    .map((section) => String(section.file || "").trim())
  for (const file of files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/i.test(file)) throw requestError(`invalid custom HTML file: ${file || "(empty)"}`, 422)
  }
  return [...new Set(files)]
}

async function readCustomHtmlResources(server, repo, artifact, data) {
  const directory = path.posix.dirname(artifact.entryPath)
  const entries = await Promise.all(customHtmlFiles(data).map(async (file) => {
    const body = await readVisualRepositoryFile(server, repo, artifact.commitSha, path.posix.join(directory, file))
    return [file, body.toString("utf8")]
  }))
  return { customHtml: Object.fromEntries(entries) }
}

async function getVisualArtifact({ store, gitServerId, projectId, issueNumber: rawIssueNumber, userId, session }) {
  const issueNumber = normalizeIssueNumber(rawIssueNumber)
  const { repo, server } = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const artifact = await resolveVisualArtifact(store, repo, server, issueNumber)
  const status = artifact.type === "decision" && (await readVisualIssueLabels(server, repo, issueNumber)).includes("flow::plan")
    ? "approved"
    : artifact.status
  const entry = await readArtifactFile(server, repo, artifact)
  const format = artifact.data && artifact.data.format || "json"
  let html
  if (format === "markdown") html = markdownDocument(await renderPlanMarkdown(server, repo, String(entry.body)), artifact)
  else {
    const data = parseVisualArtifactJson(entry.body)
    html = renderVisualArtifactDocument(data, artifact.type, await readCustomHtmlResources(server, repo, artifact, data))
  }
  return {
    artifact: { ...artifact, status }, format,
    mergeRequest: {
      id: artifact.data && artifact.data.mergeRequestId || "", number: artifact.data && artifact.data.mergeRequestNumber || 0,
      url: artifact.data && artifact.data.mergeRequestUrl || "", state: artifact.data && artifact.data.mergeRequestState || "",
    },
    repository: { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch, provider: server.type },
    html,
  }
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
      const action = decision.action === "approve" ? "通过决策" : decision.action === "select" ? "选择方案" : "讨论决策"
      const option = decision.action === "select" && (decision.optionLabel || decision.optionId)
        ? `（${inlineCode(decision.optionLabel || decision.optionId)}）`
        : ""
      return [`${index + 1}. **${action} \`${inlineCode(decision.ref)}\`${option}** — ${comment}`]
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
  const nextAction = shouldResumePlanTask
    ? `请根据以上审阅意见更新当前 ${artifactName} 产物。`
    : artifact.type === "decision" && status === "approved"
      ? "Decision 已批准，请基于已确认的选择生成并提交 Plan。"
      : ""
  return [
    `## ${title}`,
    "",
    `Status: **${status}**`,
    "",
    ...reviewItemLines(review.payload && review.payload.items || []),
    ...(nextAction ? ["", nextAction] : []),
  ].join("\n")
}
function decisionRequirementsFromData(data = {}) {
  return (Array.isArray(data.decisions) ? data.decisions : []).flatMap((item) => {
    if (!item || !item.id) return []
    const ref = `decisions.${item.id}`
    const options = (Array.isArray(item.options) ? item.options : []).flatMap((option, index) => {
      if (!option) return []
      const id = String(option.id ?? index).trim()
      return id ? [{ id, label: String(option.label || option.title || option.name || id), recommended: option.recommended === true }] : []
    })
    const type = item.type === "approval" || !options.length ? "approval" : "choice"
    const recommendedOptionId = String(item.recommendedOptionId || item.recommended || options.find((option) => option.recommended)?.id || "").trim()
    return [{ ref, id: String(item.id), type, options, recommendedOptionId }]
  })
}

async function decisionRequirements(server, repo, artifact) {
  try {
    const data = JSON.parse((await readVisualRepositoryFile(server, repo, artifact.commitSha, artifact.entryPath)).toString("utf8"))
    return decisionRequirementsFromData(data)
  } catch { return [] }
}

function pendingDecisionApprovalRefs(requiredRefs, drafts) {
  const refs = (requiredRefs || []).map((requirement) => typeof requirement === "string" ? requirement : requirement.ref)
  const reviewedRefs = new Set((drafts || [])
    .filter((item) => item && item.decision && item.decision.ref)
    .map((item) => item.decision.ref))
  return refs.filter((ref) => !reviewedRefs.has(ref))
}

function createVisualReview(artifact, userId, input, items, status) {
  const now = new Date().toISOString()
  return {
    id: `visual_review_${crypto.randomBytes(8).toString("hex")}`,
    artifactId: artifact.id,
    userId: userId || "",
    kind: input.kind || artifact.type,
    state: "submitted",
    status,
    payload: { ...input, kind: input.kind || artifact.type, status, items },
    submittedAt: now,
    createdAt: now,
    updatedAt: now,
  }
}

function decisionCompletionItem(artifact, userId, requirement) {
  const now = new Date().toISOString()
  const choice = requirement.type === "choice"
  const option = choice ? requirement.options.find((item) => item.id === requirement.recommendedOptionId) : undefined
  if (choice && !option) throw requestError(`decision ${requirement.ref} requires a recommended option`)
  return {
    id: `visual_draft_${crypto.randomBytes(8).toString("hex")}`,
    artifactId: artifact.id,
    userId: userId || "",
    targetType: "artifact",
    targetId: requirement.ref,
    sourceRefs: [{ type: "decision", path: artifact.entryPath, label: "决策" }],
    decision: choice
      ? { action: "select", ref: requirement.ref, id: requirement.id, optionId: option.id, optionLabel: option.label }
      : { action: "approve", ref: requirement.ref, id: requirement.id },
    comment: choice ? `选择方案：${option.label}` : `通过决策：${requirement.ref}`,
    severity: "note",
    intent: "refinement",
    createdAt: now,
    updatedAt: now,
  }
}

async function submitVisualReview({ store, gitServerId, projectId, issueNumber, userId, session, input = {} }) {
  const { repo, server } = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const artifact = await resolveVisualArtifact(store, repo, server, normalizeIssueNumber(issueNumber))
  let drafts = Array.isArray(input.items) ? input.items.filter(Boolean) : []
  if (artifact.type === "decision" && input.approveAll === true) {
    const requirements = await decisionRequirements(server, repo, artifact)
    if (!requirements.length) throw requestError("decision artifact has no reviewable decisions")
    const pending = new Set(pendingDecisionApprovalRefs(requirements, drafts))
    drafts = [...drafts, ...requirements.filter((item) => pending.has(item.ref)).map((item) => decisionCompletionItem(artifact, userId, item))]
  }
  if (!drafts.length) throw requestError("no review drafts to submit")
  let status = "changes-requested"
  if (artifact.type === "decision") {
    const requirements = await decisionRequirements(server, repo, artifact)
    const discussed = drafts.some((item) => item.decision && item.decision.action === "discuss")
    const completed = requirements.length > 0 && requirements.every((requirement) => drafts.some((item) => {
      const decision = item.decision
      if (!decision || decision.ref !== requirement.ref) return false
      if (requirement.type === "approval") return decision.action === "approve"
      return decision.action === "select" && requirement.options.some((option) => option.id === decision.optionId)
    }))
    status = !discussed && completed ? "approved" : "changes-requested"
  }
  if (artifact.type === "decision" && status === "approved") {
    const review = createVisualReview(artifact, userId, input, drafts, status)
    await applyVisualIssueLabels(server, repo, artifact.issueNumber, { "flow::": "flow::plan" })
    const providerComment = await createPlanMergeRequestComment(server, repo, artifact.data && artifact.data.mergeRequestNumber, buildReviewComment(artifact, review, status))
    return { review, status, providerComment, flow: "flow::plan" }
  }
  const review = createVisualReview(artifact, userId, input, drafts, status)
  const flow = artifact.type === "decision" ? "flow::clarify" : "flow::approve"
  await applyVisualIssueLabels(server, repo, artifact.issueNumber, { "flow::": flow })
  const providerComment = await createPlanMergeRequestComment(server, repo, artifact.data && artifact.data.mergeRequestNumber, buildReviewComment(artifact, review, status))
  return { review, status, providerComment, flow }
}

async function approveVisualPlan({ store, gitServerId, projectId, issueNumber, userId, session }) {
  const { repo, server } = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const artifact = await resolveVisualArtifact(store, repo, server, normalizeIssueNumber(issueNumber), "plan")
  const merge = await mergePlanMergeRequest(server, repo, artifact.data && artifact.data.mergeRequestNumber)
  const review = createVisualReview(artifact, userId, { kind: "approval", merge }, [], "approved")
  await createPlanMergeRequestComment(server, repo, artifact.data && artifact.data.mergeRequestNumber, buildReviewComment(artifact, review, "approved"))
  await applyVisualIssueLabels(server, repo, artifact.issueNumber, { "flow::": "flow::build" })
  return { artifact: { ...artifact, status: "approved" }, review, merge, flow: "flow::build" }
}

export { approveVisualPlan, buildReviewComment, decisionRequirementsFromData, getVisualArtifact, listReviewablePlanArtifacts, parseArtifactMarker, parseVisualArtifactJson, pendingDecisionApprovalRefs, submitVisualReview }
