// @ts-nocheck
import crypto from "node:crypto"
import path from "node:path"
import domain from "issue-flow/domain"

import { createProviderIssue, getProviderIssueSnapshot, updateProviderIssue, updateProviderIssueState } from "./issue-provider.js"
import { getProviderMergeRequestPreview } from "./merge-request-provider.js"
import { allOptimizationProposalsTerminal, deriveOptimizationProposalStates, optimizationSourceIssueNumber, parseProposalMarker, proposalMarker, validateOptimizationArtifact } from "./optimization-artifact.js"
import { normalizePreviewPath, previewDescriptorForPath, previewableChangedFiles } from "./preview/registry.js"
import { issueFlowMarkers } from "./provenance-marker.js"
import { listIssuePullRequestSummaries } from "./pull-request-facts.js"
import { applyVisualIssueLabels, closePlanMergeRequest, createPlanMergeRequestComment, listPlanMergeRequestComments, listPlanMergeRequests, mergePlanMergeRequest, readVisualIssueLabels, readVisualRepositoryFile, renderPlanMarkdown } from "./visual-provider.js"
import { renderVisualArtifactDocument } from "./visual-renderer.js"

const ISSUE_FLOW_FEEDBACK_REPOSITORY = "nil4u/issue-flow"

function requestError(message, status = 400, code = "visual_artifact_error") {
  const error = new Error(message); error.status = status; error.code = code; return error
}
function normalizeIssueNumber(value) {
  const issueNumber = Number.parseInt(String(value || ""), 10)
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) throw requestError("issue number must be positive")
  return issueNumber
}
function normalizeMergeRequestNumber(value) {
  if (value === undefined || value === null || value === "") return undefined
  const mergeRequestNumber = Number.parseInt(String(value), 10)
  if (!Number.isFinite(mergeRequestNumber) || mergeRequestNumber <= 0) throw requestError("merge request number must be positive")
  return mergeRequestNumber
}
function normalizeRepoPath(value) {
  const normalized = path.posix.normalize(String(value || "").replace(/\\/g, "/").replace(/^\/+/, ""))
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) throw requestError("invalid visual artifact path")
  return normalized
}

function parseArtifactMarker(mergeRequest = {}) {
  const marker = domain.parsePlanArtifactMarker(mergeRequest.body)
  if (!marker) return undefined
  let entryPath
  try { entryPath = normalizeRepoPath(marker.path) } catch { return undefined }
  return {
    type: marker.artifact, format: marker.format, issueNumber: marker.issueNumber,
    branch: marker.branch, commitSha: marker.commit, entryPath,
    mergeRequestId: String(mergeRequest.id || ""), mergeRequestNumber: Number(mergeRequest.number), mergeRequestUrl: mergeRequest.url || "",
    mergeRequestState: mergeRequest.state || "", merged: Boolean(mergeRequest.merged), baseBranch: mergeRequest.baseBranch || "",
    publishedAt: mergeRequest.updatedAt || mergeRequest.createdAt || new Date().toISOString(),
  }
}

function planFilePathFromBody(body = "") {
  const section = String(body).match(/^##[ \t]+Plan file[ \t]*\r?\n([\s\S]*?)(?=^##[ \t]+|(?![\s\S]))/im)
  if (!section) return undefined
  const quoted = section[1].match(/`([^`\r\n]+)`/)
  const plain = section[1].split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  const value = String(quoted && quoted[1] || plain || "").replace(/^[-*]\s+/, "").replace(/^`|`$/g, "").replace(/[.,;:]+$/, "")
  if (!value) return undefined
  return normalizePreviewPath(value)
}

function mergeRequestIssueNumber(mergeRequest = {}) {
  return issueFlowMarkers(mergeRequest.body).sourceIssueNumber || parseArtifactMarker(mergeRequest)?.issueNumber || 0
}

function mergeRequestArtifacts(mergeRequest, issueNumber) {
  const marker = parseArtifactMarker(mergeRequest)
  const declaredPath = planFilePathFromBody(mergeRequest.body)
  const markerPath = marker && marker.issueNumber === issueNumber ? marker.entryPath : undefined
  const changed = previewableChangedFiles(mergeRequest.files)
  const hints = [declaredPath, markerPath].map(previewDescriptorForPath).filter(Boolean)
  const descriptors = changed.length ? changed : hints
  const unique = [...new Map(descriptors.map((descriptor) => [descriptor.entryPath, descriptor])).values()]
  const defaultPath = [declaredPath, markerPath].find((hint) => unique.some((descriptor) => descriptor.entryPath === hint))
  const workflow = (mergeRequest.labels || []).includes("mr-by::plan") ? "plan" : "preview"
  const coordinates = unique.map((descriptor) => {
    const type = descriptor.kind === "markdown" && workflow === "plan"
      ? "plan"
      : descriptor.kind === "visual" && descriptor.entryPath === markerPath
        ? marker.type
        : descriptor.kind
    return {
      type,
      format: descriptor.format,
      previewer: descriptor.previewer,
      workflow,
      issueNumber,
      branch: mergeRequest.headBranch || marker?.branch || "",
      commitSha: mergeRequest.commitSha || marker?.commitSha || "",
      entryPath: descriptor.entryPath,
      mergeRequestId: String(mergeRequest.id || ""),
      mergeRequestNumber: Number(mergeRequest.number),
      mergeRequestUrl: mergeRequest.url || "",
      mergeRequestState: mergeRequest.state || "",
      merged: Boolean(mergeRequest.merged),
      baseBranch: mergeRequest.baseBranch || "",
      publishedAt: mergeRequest.updatedAt || mergeRequest.createdAt || new Date().toISOString(),
    }
  })
  return coordinates.sort((left, right) => {
    const defaultRank = Number(right.entryPath === defaultPath) - Number(left.entryPath === defaultPath)
    return defaultRank || left.entryPath.localeCompare(right.entryPath)
  })
}

function visualArtifactTypeFromData(data) {
  const artifact = String(data && data.artifact || "").trim().toLowerCase()
  if (artifact !== "decision" && artifact !== "plan") throw requestError('visual artifact field must equal "decision" or "plan"', 422)
  return artifact
}

async function resolveVisualArtifactTypes(server, repo, artifacts) {
  return Promise.all(artifacts.map(async (artifact) => {
    if (artifact.previewer !== "issue-flow-visual") return artifact
    const body = await readVisualRepositoryFile(server, repo, artifact.commitSha, artifact.entryPath)
    return { ...artifact, type: visualArtifactTypeFromData(parseVisualArtifactJson(body)) }
  }))
}

function mergeRequestArtifact(mergeRequest, issueNumber, type, artifactPath) {
  const requestedPath = artifactPath ? normalizePreviewPath(artifactPath) : undefined
  const candidates = mergeRequestArtifacts(mergeRequest, issueNumber).filter((candidate) => !type || candidate.type === type)
  if (requestedPath) {
    return candidates.find((candidate) => candidate.entryPath === requestedPath)
  }
  return candidates[0]
}

function planMergeRequestFromSnapshot(snapshot = {}) {
  const mergeRequest = snapshot.mergeRequest || {}
  return {
    id: mergeRequest.id,
    number: mergeRequest.number,
    body: mergeRequest.body || "",
    title: mergeRequest.title || "",
    state: mergeRequest.state || "",
    merged: Boolean(mergeRequest.merged),
    headBranch: mergeRequest.sourceBranch || "",
    baseBranch: mergeRequest.targetBranch || "",
    commitSha: mergeRequest.headSha || "",
    url: mergeRequest.webUrl || "",
    createdAt: mergeRequest.createdAt || "",
    updatedAt: mergeRequest.updatedAt || "",
    labels: mergeRequest.labels || [],
    files: snapshot.files || [],
    filesLoaded: snapshot.filesLoaded !== false,
  }
}

async function readPlanMergeRequestSnapshot(server, repo, mergeRequestNumber, input = {}) {
  return planMergeRequestFromSnapshot(await getProviderMergeRequestPreview(server, repo, mergeRequestNumber, input))
}

function rankedPlanMergeRequests(mergeRequests) {
  const stateRank = (item) => item.state === "opened" || item.state === "open" ? 2 : item.merged ? 1 : 0
  return [...mergeRequests].sort((left, right) => stateRank(right) - stateRank(left) || String(right.updatedAt).localeCompare(String(left.updatedAt)))
}

function planMergeRequestFactCandidate(fact = {}) {
  return {
    number: Number(fact.prNumber || 0),
    state: String(fact.state || "open"),
    merged: fact.state === "merged",
    updatedAt: String(fact.updatedAt || ""),
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

async function discoverVisualArtifacts(store, repo, server, issueNumber, type, rawMergeRequestNumber, artifactPath) {
  const mergeRequestNumber = normalizeMergeRequestNumber(rawMergeRequestNumber)
  let mergeRequests
  if (mergeRequestNumber) {
    mergeRequests = [await readPlanMergeRequestSnapshot(server, repo, mergeRequestNumber, { includeFiles: !artifactPath })]
  } else {
    const facts = (await store.listPullRequestsByIssue({
      gitServerId: repo.gitServerId,
      repositoryId: repo.serverRepoId,
      issueNumber,
    })).filter((item) => item.kind === "plan")
    mergeRequests = rankedPlanMergeRequests(facts.map(planMergeRequestFactCandidate))
  }

  for (const candidate of mergeRequests) {
    const mergeRequest = candidate.files ? candidate : await readPlanMergeRequestSnapshot(server, repo, candidate.number)
    if (mergeRequestIssueNumber(mergeRequest) !== issueNumber) continue
    let artifacts = await resolveVisualArtifactTypes(server, repo, mergeRequestArtifacts(mergeRequest, issueNumber))
    const requestedPath = artifactPath ? normalizePreviewPath(artifactPath) : undefined
    let selected = artifacts.find((artifact) => (!type || artifact.type === type) && (!requestedPath || artifact.entryPath === requestedPath))
    if (!selected && requestedPath && mergeRequest.filesLoaded === false) {
      const completeMergeRequest = await readPlanMergeRequestSnapshot(server, repo, mergeRequest.number)
      artifacts = await resolveVisualArtifactTypes(server, repo, mergeRequestArtifacts(completeMergeRequest, issueNumber))
      selected = artifacts.find((artifact) => (!type || artifact.type === type) && artifact.entryPath === requestedPath)
    }
    if (selected) return { artifacts, selected }
    if (artifactPath && artifacts.length) throw requestError("Preview file was not found in the MR", 404, "preview_file_not_found")
  }

  if (!mergeRequests.length) throw requestError("Preview MR was not found", 404, "preview_merge_request_not_found")
  throw requestError(type ? `${type} preview was not found in the MR` : "MR does not contain a previewable file", 404, "preview_file_not_found")
}

async function listReviewablePlanArtifacts({ store, gitServerId, projectId, issueNumber: rawIssueNumber, userId, session }) {
  const { repo, server } = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const issueNumber = rawIssueNumber ? normalizeIssueNumber(rawIssueNumber) : 0
  const issueFacts = issueNumber
    ? await store.listPullRequestsByIssue({ gitServerId: repo.gitServerId, repositoryId: repo.serverRepoId, issueNumber })
    : []
  const planFacts = issueFacts.filter((item) => item.kind === "plan")
  const openPlanFacts = planFacts.filter((item) => item.state === "open")
  const mergeRequests = issueNumber
    ? await Promise.all(openPlanFacts.map((item) => readPlanMergeRequestSnapshot(server, repo, item.prNumber, { includeFiles: false })))
    : await listPlanMergeRequests(server, repo, { state: "open" })
  const artifacts = mergeRequests
    .filter((item) => !item.merged && (item.state === "open" || item.state === "opened"))
    .map((item) => {
      const issueNumber = mergeRequestIssueNumber(item)
      return issueNumber > 0 ? mergeRequestArtifact(item, issueNumber) || {
        issueNumber, type: "plan", format: "markdown", mergeRequestNumber: Number(item.number),
        mergeRequestState: item.state, publishedAt: item.updatedAt || item.createdAt || "",
      } : undefined
    })
    .filter(Boolean)
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

function visualArtifactRecord(repo, issueNumber, marker) {
  const merged = marker.merged || marker.mergeRequestState === "merged"
  return {
    id: `${repo.id}:${issueNumber}:${marker.entryPath}`,
    repoId: repo.id,
    issueNumber,
    type: marker.type,
    format: marker.format,
    previewer: marker.previewer,
    workflow: marker.workflow,
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

async function resolveVisualArtifacts(store, repo, server, issueNumber, type, mergeRequestNumber, artifactPath) {
  const discovered = await discoverVisualArtifacts(store, repo, server, issueNumber, type, mergeRequestNumber, artifactPath)
  return {
    artifact: visualArtifactRecord(repo, issueNumber, discovered.selected),
    artifacts: discovered.artifacts.map((marker) => visualArtifactRecord(repo, issueNumber, marker)),
  }
}

async function resolveVisualArtifact(store, repo, server, issueNumber, type, mergeRequestNumber, artifactPath) {
  return (await resolveVisualArtifacts(store, repo, server, issueNumber, type, mergeRequestNumber, artifactPath)).artifact
}

async function readArtifactFile(server, repo, artifact) {
  const bytes = await readVisualRepositoryFile(server, repo, artifact.commitSha, artifact.entryPath)
  return { body: bytes }
}

function escapeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function markdownSectionSlug(label, index) {
  const slug = String(label || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
  return slug || `section-${index + 1}`
}

function structureMarkdownSections(renderedHtml, artifact) {
  const sections = new Map()
  let sectionIndex = 0
  const body = String(renderedHtml || "").replace(/<h([1-3])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi, (heading, level, content) => {
    const label = elementTextFromHtml(content) || `章节 ${sectionIndex + 1}`
    const slug = markdownSectionSlug(label, sectionIndex)
    const occurrence = (sections.get(slug) || 0) + 1
    sections.set(slug, occurrence)
    const uniqueSlug = occurrence === 1 ? slug : `${slug}-${occurrence}`
    const ref = `markdown.${artifact.type}.sections.${uniqueSlug}`
    sectionIndex += 1
    return `<section class="markdown-review-section" data-comment-scope="section" data-comment-label="${escapeHtmlAttribute(label)}" data-section-level="${level}" data-ref="${escapeHtmlAttribute(ref)}">${heading}</section>`
  })
  if (sectionIndex > 0) return { body, sectionCount: sectionIndex }
  return { body: String(renderedHtml || ""), sectionCount: 0 }
}

function anchorMarkdownBlocks(renderedHtml, artifact) {
  let blockIndex = 0
  return String(renderedHtml || "").replace(/<(p|li|pre|blockquote|td|th)(\s[^>]*)?>/gi, (opening, tag, attributes = "") => {
    const ref = `markdown.${artifact.type}.blocks.${blockIndex++}`
    return /\sdata-ref\s*=/i.test(attributes)
      ? opening
      : `<${tag}${attributes} data-ref="${escapeHtmlAttribute(ref)}">`
  })
}

function markdownDocument(renderedHtml, artifact) {
  const structured = structureMarkdownSections(renderedHtml, artifact)
  const body = anchorMarkdownBlocks(structured.body, artifact)
  const fallbackAttributes = structured.sectionCount === 0
    ? ` data-comment-scope="section" data-comment-label="Markdown Plan" data-ref="markdown.${artifact.type}"`
    : ` data-ref="markdown.${artifact.type}"`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    :root{color:#18181b;background:#fff;font:15px/1.7 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}*{box-sizing:border-box}body{margin:0;padding:48px 32px 72px}article{max-width:860px;margin:0 auto;overflow-wrap:anywhere}h1,h2,h3{line-height:1.3;margin:1.6em 0 .6em;text-wrap:balance}.markdown-review-section{position:relative;margin:1.6em -14px .6em;padding:10px 14px;border:1px solid transparent;border-radius:10px;scroll-margin-top:24px;transition:background-color .12s ease,border-color .12s ease}.markdown-review-section:hover{border-color:#e4e4e7;background:#fafafa}.markdown-review-section h1,.markdown-review-section h2,.markdown-review-section h3{margin:0}h1{font-size:30px;border-bottom:1px solid #e4e4e7;padding-bottom:12px}h2{font-size:23px}h3{font-size:18px}p,ul,ol,pre,table,blockquote{margin:1em 0;text-wrap:pretty}pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}code{background:#f4f4f5;border-radius:4px;padding:.15em .35em}pre{max-width:100%;overflow:auto;background:#18181b;color:#fafafa;border-radius:8px;padding:16px}pre code{background:none;padding:0}table{width:100%;border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid #e4e4e7;padding:8px 10px;text-align:left}blockquote{margin-left:0;border-left:1px solid #a1a1aa;padding-left:16px;color:#52525b}a{color:#2563eb}img{max-width:100%}@media(max-width:760px){body{padding:24px 18px 48px}.markdown-review-section{margin-left:-8px;margin-right:-8px;padding-left:8px;padding-right:8px}}
  </style></head><body><article${fallbackAttributes}>${body}</article></body></html>`
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

async function optimizationRuntime(server, repo, artifact, data) {
  const [comments, parentIssue] = await Promise.all([
    listPlanMergeRequestComments(server, repo, artifact.data.mergeRequestNumber),
    getProviderIssueSnapshot(server, repo, artifact.issueNumber),
  ])
  const sourceIssueNumber = optimizationSourceIssueNumber(parentIssue && parentIssue.body)
  const childIssueNumbers = [...new Set(comments.flatMap((comment) => {
    const marker = parseProposalMarker(comment && comment.body)
    if (!marker || marker.optimizationIssueNumber !== artifact.issueNumber || marker.action === "ignored") return []
    if (marker.childIssueNumber) return [marker.childIssueNumber]
    const legacyMatch = String(comment && comment.body || "").match(/(?:\/issues\/|Issue：#)(\d+)/i)
    return legacyMatch ? [Number.parseInt(legacyMatch[1], 10)] : []
  }))]
  const relatedIssueNumbers = [...new Set([sourceIssueNumber, ...childIssueNumbers].filter(Boolean))]
  const relatedIssues = await Promise.all(relatedIssueNumbers.map((issueNumber) => getProviderIssueSnapshot(server, repo, issueNumber)))
  const issues = [parentIssue, ...relatedIssues]
  const states = deriveOptimizationProposalStates(data, artifact.issueNumber, comments, issues)
  return {
    sourceIssueNumber,
    comments,
    issues,
    proposals: states.map((state) => {
      const proposal = data.proposals.find((item) => item.id === state.id)
      return proposal && proposal.kind === "issue-flow-feedback"
        ? { ...state, kind: proposal.kind, feedback: developerFeedbackDraft(proposal, repo, sourceIssueNumber) }
        : { ...state, kind: proposal && proposal.kind || "project-change" }
    }),
  }
}

function developerFeedbackDraft(proposal, repo, sourceIssueNumber) {
  const labels = ["type::bug", "status::active", "flow::triage", "automation::off", proposal.issue.priority, proposal.issue.size, ...(proposal.issue.labels || [])]
  const body = [
    proposal.issue.body.trim(),
    "## 建议方案",
    proposal.solution.trim(),
    "## 验证方式",
    proposal.validation.map((item) => `- ${String(item).trim()}`).join("\n"),
    "## 来源",
    [`- Repository: ${repo.fullName}`, `- Source Issue: #${sourceIssueNumber}`].join("\n"),
  ].join("\n\n")
  const params = new URLSearchParams({ title: proposal.issue.title, labels: labels.join(",") })
  return {
    title: proposal.issue.title,
    body,
    labels,
    text: [`# ${proposal.issue.title}`, "", body, "", `Labels: ${labels.join(", ")}`].join("\n"),
    url: `https://github.com/${ISSUE_FLOW_FEEDBACK_REPOSITORY}/issues/new?${params}`,
  }
}

async function getVisualArtifact({ store, gitServerId, projectId, issueNumber: rawIssueNumber, mergeRequestNumber, artifactPath, userId, session }) {
  const issueNumber = normalizeIssueNumber(rawIssueNumber)
  const { repo, server } = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const resolved = await resolveVisualArtifacts(store, repo, server, issueNumber, undefined, mergeRequestNumber, artifactPath)
  const decisionApproved = resolved.artifacts.some((artifact) => artifact.type === "decision" && artifact.workflow === "plan")
    && (await readVisualIssueLabels(server, repo, issueNumber)).includes("flow::plan")
  const artifacts = resolved.artifacts.map((artifact) => artifact.type === "decision" && artifact.workflow === "plan" && decisionApproved ? { ...artifact, status: "approved" } : artifact)
  const artifact = artifacts.find((candidate) => candidate.entryPath === resolved.artifact.entryPath) || resolved.artifact
  const entry = await readArtifactFile(server, repo, artifact)
  const format = artifact.data && artifact.data.format || "json"
  let html
  let optimization
  if (format === "markdown") html = markdownDocument(await renderPlanMarkdown(server, repo, String(entry.body)), artifact)
  else {
    const data = domain.validateVisualArtifactData(parseVisualArtifactJson(entry.body), artifact.type)
    if (artifact.type === "optimization") {
      validateOptimizationArtifact(data)
      optimization = await optimizationRuntime(server, repo, artifact, data)
    }
    const optimizationStates = optimization && optimization.proposals.map((proposal) => ({
      ...proposal,
      childIssue: proposal.childIssue ? {
        ...proposal.childIssue,
        webUrl: `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/issues/${proposal.childIssue.number}`,
      } : null,
    }))
    html = renderVisualArtifactDocument(data, artifact.type, {
      ...await readCustomHtmlResources(server, repo, artifact, data),
      optimizationStates,
    })
  }
  const associatedMergeRequests = (await listIssuePullRequestSummaries(store, repo, issueNumber))
    .map((mergeRequest) => ({
      number: mergeRequest.number,
      title: mergeRequest.title,
      state: mergeRequest.state,
      labels: mergeRequest.labels,
    }))
  return {
    artifact, artifacts, format,
    mergeRequest: {
      id: artifact.data && artifact.data.mergeRequestId || "", number: artifact.data && artifact.data.mergeRequestNumber || 0,
      url: artifact.data && artifact.data.mergeRequestUrl || "", state: artifact.data && artifact.data.mergeRequestState || "",
    },
    repository: { id: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch, provider: server.type },
    associatedMergeRequests,
    optimization: optimization ? { sourceIssueNumber: optimization.sourceIssueNumber, proposals: optimization.proposals } : undefined,
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
    const pageContent = visualTarget.selectionText || element.ariaLabel || elementTextFromHtml(element.html)
    const lines = [`${index + 1}. **${comment}**`]
    if (artifactPath) lines.push(`   - 产物：\`${inlineCode(artifactPath)}\``)
    if (anchor) lines.push(`   - 锚点：\`${inlineCode(anchor)}\``)
    if (pageContent) lines.push(`   - ${visualTarget.selectionText ? "引用" : "页面内容"}：${pageContent}`)
    return lines
  })
}
function buildReviewComment(artifact, review, status) {
  const planWorkflow = artifact.workflow === "plan" || artifact.data && artifact.data.workflow === "plan"
  const title = !planWorkflow ? "Preview Review" : artifact.type === "decision" ? "Decision Review" : artifact.type === "optimization" ? "Automation Optimization Review" : artifact.data && artifact.data.format === "markdown" ? "Markdown Plan Review" : "Visual Plan Review"
  const shouldResumePlanTask = planWorkflow && status === "changes-requested"
  const artifactName = artifact.type === "decision" ? "Decision" : artifact.type === "optimization" ? "Optimization Plan" : "Plan"
  const nextAction = shouldResumePlanTask
    ? `请根据以上审阅意见更新当前 ${artifactName} 产物。`
    : planWorkflow && artifact.type === "decision" && status === "approved"
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

async function submitVisualReview({ store, gitServerId, projectId, issueNumber, mergeRequestNumber, artifactPath, userId, session, input = {} }) {
  const { repo, server } = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const artifact = await resolveVisualArtifact(store, repo, server, normalizeIssueNumber(issueNumber), undefined, mergeRequestNumber, artifactPath)
  const planWorkflow = artifact.workflow === "plan"
  let drafts = Array.isArray(input.items) ? input.items.filter(Boolean) : []
  if (!planWorkflow && input.approveAll === true) throw requestError("Only Plan MRs support decision approval", 409, "preview_not_approvable")
  if (planWorkflow && artifact.type === "decision" && input.approveAll === true) {
    const requirements = await decisionRequirements(server, repo, artifact)
    if (!requirements.length) throw requestError("decision artifact has no reviewable decisions")
    const pending = new Set(pendingDecisionApprovalRefs(requirements, drafts))
    drafts = [...drafts, ...requirements.filter((item) => pending.has(item.ref)).map((item) => decisionCompletionItem(artifact, userId, item))]
  }
  if (!drafts.length) throw requestError("no review drafts to submit")
  let status = planWorkflow ? "changes-requested" : "commented"
  if (planWorkflow && artifact.type === "decision") {
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
  if (planWorkflow && artifact.type === "decision" && status === "approved") {
    const review = createVisualReview(artifact, userId, input, drafts, status)
    const flow = domain.resolvePlanArtifactTransition("decision").flow
    await applyVisualIssueLabels(server, repo, artifact.issueNumber, { "flow::": flow })
    const providerComment = await createPlanMergeRequestComment(server, repo, artifact.data && artifact.data.mergeRequestNumber, buildReviewComment(artifact, review, status))
    return { review, status, providerComment, flow }
  }
  const review = createVisualReview(artifact, userId, input, drafts, status)
  if (!planWorkflow) {
    const providerComment = await createPlanMergeRequestComment(server, repo, artifact.data && artifact.data.mergeRequestNumber, buildReviewComment(artifact, review, status))
    return { review, status, providerComment }
  }
  const flow = artifact.type === "decision" ? "flow::clarify" : "flow::approve"
  await applyVisualIssueLabels(server, repo, artifact.issueNumber, { "flow::": flow })
  const providerComment = await createPlanMergeRequestComment(server, repo, artifact.data && artifact.data.mergeRequestNumber, buildReviewComment(artifact, review, status))
  return { review, status, providerComment, flow }
}

async function approveVisualPlan({ store, gitServerId, projectId, issueNumber, mergeRequestNumber, artifactPath, userId, session }) {
  const { repo, server } = await requireVisualContext(store, gitServerId, projectId, userId, session)
  const artifact = await resolveVisualArtifact(store, repo, server, normalizeIssueNumber(issueNumber), "plan", mergeRequestNumber, artifactPath)
  if (artifact.workflow !== "plan") throw requestError("Only Plan MRs can be approved from Preview", 409, "preview_not_approvable")
  const merge = await mergePlanMergeRequest(server, repo, artifact.data && artifact.data.mergeRequestNumber)
  const review = createVisualReview(artifact, userId, { kind: "approval", merge }, [], "approved")
  await createPlanMergeRequestComment(server, repo, artifact.data && artifact.data.mergeRequestNumber, buildReviewComment(artifact, review, "approved"))
  const flow = domain.resolvePlanArtifactTransition("plan").flow
  await applyVisualIssueLabels(server, repo, artifact.issueNumber, { "flow::": flow })
  return { artifact: { ...artifact, status: "approved" }, review, merge, flow }
}

function optimizationProposalById(data, proposalId) {
  const proposal = data.proposals.find((item) => item.id === proposalId)
  if (!proposal) throw requestError(`optimization proposal not found: ${proposalId}`, 404, "optimization_proposal_not_found")
  return proposal
}

function proposalIssueLabels(proposal) {
  return [...domain.applyManagedLabels([], {
    type: proposal.issue.type,
    status: "status::active",
    flow: proposal.issue.flow,
    automation: "automation::build",
    priority: proposal.issue.priority,
    size: proposal.issue.size,
  }), ...(proposal.issue.labels || [])]
}

async function loadOptimizationActionContext(input) {
  const issueNumber = normalizeIssueNumber(input.issueNumber)
  const { repo, server } = await requireVisualContext(input.store, input.gitServerId, input.projectId, input.userId, input.session)
  const artifact = await resolveVisualArtifact(input.store, repo, server, issueNumber, "optimization")
  if (artifact.status === "approved" || !["open", "opened"].includes(artifact.data.mergeRequestState)) throw requestError("optimization Plan is no longer open", 409, "optimization_plan_closed")
  const data = validateOptimizationArtifact(parseVisualArtifactJson((await readArtifactFile(server, repo, artifact)).body))
  const runtime = await optimizationRuntime(server, repo, artifact, data)
  if (!runtime.sourceIssueNumber) throw requestError("optimization source issue marker is missing", 422, "optimization_source_missing")
  return { repo, server, artifact, data, runtime }
}

async function finalizeOptimizationIfComplete({ server, repo, artifact, data, runtime }) {
  const states = deriveOptimizationProposalStates(data, artifact.issueNumber, runtime.comments, runtime.issues)
  if (!allOptimizationProposalsTerminal(states)) return { completed: false, proposals: states }
  const parent = runtime.issues.find((issue) => issue.number === artifact.issueNumber)
  if (!parent) throw requestError("optimization issue was not found", 404, "optimization_issue_not_found")
  const source = runtime.issues.find((issue) => issue.number === runtime.sourceIssueNumber)
  if (!source) throw requestError("optimization source issue was not found", 404, "optimization_source_not_found")
  await closePlanMergeRequest(server, repo, artifact.data.mergeRequestNumber)
  const parentLabels = (parent && parent.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean)
  await updateProviderIssue(server, repo, artifact.issueNumber, {
    labels: domain.applyManagedLabels(parentLabels, { status: "status::done" }, ["flow"]),
  })
  await updateProviderIssueState(server, repo, artifact.issueNumber, "close")
  const sourceLabels = (source && source.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean)
  await updateProviderIssue(server, repo, runtime.sourceIssueNumber, {
    labels: domain.applyManagedLabels(sourceLabels, { optimizationState: "optimization::analyzed" }),
  })
  return { completed: true, proposals: states }
}

async function approveOptimizationProposal(input) {
  const context = await loadOptimizationActionContext(input)
  const proposal = optimizationProposalById(context.data, String(input.proposalId || ""))
  const current = context.runtime.proposals.find((item) => item.id === proposal.id)
  if (current.state === "ignored") throw requestError("ignored proposal cannot be approved", 409, "optimization_proposal_ignored")
  if (current.childIssue) return { proposal: current, created: false }
  if (proposal.kind !== "project-change") throw requestError("Developer feedback does not create an execution Issue", 409, "developer_feedback_not_executable")
  const marker = proposalMarker({
    optimizationIssueNumber: context.artifact.issueNumber,
    sourceIssueNumber: context.runtime.sourceIssueNumber,
    proposalId: proposal.id,
  })
  const childIssue = await createProviderIssue(context.server, context.repo, {
    title: proposal.issue.title,
    body: `${proposal.issue.body.trim()}\n\n${marker}`,
    labels: proposalIssueLabels(proposal),
  })
  const childMarker = proposalMarker({
    optimizationIssueNumber: context.artifact.issueNumber,
    sourceIssueNumber: context.runtime.sourceIssueNumber,
    proposalId: proposal.id,
    childIssueNumber: childIssue.number,
  })
  await createPlanMergeRequestComment(
    context.server,
    context.repo,
    context.artifact.data.mergeRequestNumber,
    `<!-- issue-flow:source source_agent=issue-flow -->\n${childMarker}\n已通过优化方案并创建执行 Issue：${childIssue.webUrl || `#${childIssue.number}`}。`,
  )
  const state = { id: proposal.id, state: childProposalStateForResponse(childIssue), childIssue: { number: childIssue.number, title: childIssue.title, state: childIssue.state, webUrl: childIssue.webUrl || "" } }
  return { proposal: state, created: true }
}

function childProposalStateForResponse(issue) {
  const labels = (issue.labels || []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean)
  return labels.includes("flow::build") ? "executing" : "created"
}

async function ignoreOptimizationProposal(input) {
  const context = await loadOptimizationActionContext(input)
  const proposal = optimizationProposalById(context.data, String(input.proposalId || ""))
  if (proposal.kind !== "project-change") throw requestError("Developer feedback cannot be ignored", 409, "developer_feedback_not_actionable")
  const current = context.runtime.proposals.find((item) => item.id === proposal.id)
  if (current.childIssue) throw requestError("created proposal cannot be ignored", 409, "optimization_proposal_created")
  if (current.state !== "ignored") {
    const marker = proposalMarker({
      optimizationIssueNumber: context.artifact.issueNumber,
      sourceIssueNumber: context.runtime.sourceIssueNumber,
      proposalId: proposal.id,
      action: "ignored",
    })
    await createPlanMergeRequestComment(context.server, context.repo, context.artifact.data.mergeRequestNumber, `<!-- issue-flow:source source_agent=issue-flow -->\n${marker}\n已忽略优化方案：**${proposal.title}**`)
    context.runtime.comments.push({ body: marker })
  }
  const completion = await finalizeOptimizationIfComplete(context)
  return { proposal: completion.proposals.find((item) => item.id === proposal.id), completion }
}

export { approveOptimizationProposal, approveVisualPlan, buildReviewComment, decisionRequirementsFromData, developerFeedbackDraft, finalizeOptimizationIfComplete, getVisualArtifact, ignoreOptimizationProposal, listReviewablePlanArtifacts, markdownDocument, mergeRequestArtifact, mergeRequestArtifacts, parseArtifactMarker, parseVisualArtifactJson, pendingDecisionApprovalRefs, planFilePathFromBody, structureMarkdownSections, submitVisualReview }
