// @ts-nocheck

import crypto from "node:crypto"
import fs from "node:fs"

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "")
}

function normalizeApiUrl(baseUrl, apiUrl) {
  const explicit = normalizeBaseUrl(apiUrl)
  if (explicit) return explicit
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  return normalizedBaseUrl ? `${normalizedBaseUrl}/api/v4` : ""
}

function hostFromBaseUrl(baseUrl = "") {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).hostname
  } catch {
    return ""
  }
}

function primaryDomainFromBaseUrl(baseUrl = "") {
  const parts = hostFromBaseUrl(baseUrl).split(".").filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join(".") : parts[0] || ""
}

function normalizeOauthScopes(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope && scope !== "read_user")
    .join(" ")
}

function normalizeAutomation(input = {}) {
  return {
    autoDefault: input.autoDefault || "triage",
    reviewEnabled: Boolean(input.reviewEnabled),
    agent: input.agent || "codex",
    runnerId: input.runnerId || "",
    responseMode: input.responseMode || "async",
  }
}

function normalizeAgentrix(input = {}, apiKeyFingerprint = "") {
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl || ""),
    apiKeyFingerprint,
    runnerId: input.runnerId || "",
  }
}

function normalizeRunnerId(value = "") {
  return String(value || "").trim()
}

function normalizeGitServer(input = {}, fingerprints = {}) {
  const type = input.type || "gitlab"
  const id = String(input.id || "").trim()
  const baseUrl = normalizeBaseUrl(input.baseUrl || "")
  const oauth = input.oauth || {}
  const commitAuthor = input.commitAuthor || input.commit_author || {}
  const commitAuthorName = String(commitAuthor.name || input.commitAuthorName || input.commit_author_name || "issue-flow").trim()
  const commitAuthorEmail = String(
    commitAuthor.email
      || input.commitAuthorEmail
      || input.commit_author_email
      || (primaryDomainFromBaseUrl(baseUrl) ? `issue-flow@${primaryDomainFromBaseUrl(baseUrl)}` : "")
  ).trim()
  const agentrixGitServerId = input.agentrixGitServerId || input.agentrix_git_server_id || input.agentrix && input.agentrix.gitServerId || ""
  return {
    id,
    type,
    name: input.name || baseUrl || id,
    baseUrl,
    apiUrl: normalizeApiUrl(baseUrl, input.apiUrl),
    tokenAuth: input.tokenAuth || "bearer",
    oauth: {
      clientId: oauth.clientId || "",
      scopes: normalizeOauthScopes(oauth.scopes),
      clientSecretFingerprint: fingerprints.oauthClientSecretFingerprint || "",
    },
    webhook: {
      secretFingerprint: fingerprints.webhookSecretFingerprint || "",
    },
    agentrixGitServerId,
    adminPatFingerprint: fingerprints.adminPatFingerprint || "",
    botPatFingerprint: fingerprints.botPatFingerprint || "",
    commitAuthor: {
      name: commitAuthorName,
      email: commitAuthorEmail,
    },
  }
}

function asDate(value) {
  return value ? new Date(value) : new Date()
}

function timestampValue(value) {
  return value instanceof Date ? value.toISOString() : value || ""
}

function rowData(row) {
  if (!row) return undefined
  if (typeof row.data === "string") return JSON.parse(row.data)
  return row.data
}

function normalizeUser(input = {}) {
  return {
    displayName: input.displayName || input.name || input.username || "",
    email: input.email || "",
    avatarUrl: input.avatarUrl || "",
    role: input.role || "member",
  }
}

function normalizeGitAccount(input = {}) {
  const provider = input.provider || input.gitServer && input.gitServer.type || "gitlab"
  const gitServerId = input.gitServerId || input.gitServer && input.gitServer.id || ""
  const providerUserId = String(input.providerUserId || input.id || input.username || "").trim()
  return {
    provider,
    gitServerId,
    providerUserId,
    username: input.username || "",
    displayName: input.displayName || input.name || input.username || "",
    email: input.email || "",
    avatarUrl: input.avatarUrl || "",
    scopes: input.scopes || [],
  }
}

function splitRepoFullName(fullName = "") {
  const parts = String(fullName || "").split("/").filter(Boolean)
  return {
    owner: parts[0] || "",
    name: parts[parts.length - 1] || "",
  }
}

function normalizeRepoIdentity(input = {}) {
  const fullName = String(
    input.fullName
    || input.projectPath
    || input.pathWithNamespace
    || ""
  ).trim()
  const split = splitRepoFullName(fullName)
  return {
    id: input.id || "",
    gitServerId: input.gitServerId || "",
    serverRepoId: String(input.serverRepoId || input.projectId || input.remoteId || input.id || fullName).trim(),
    owner: input.owner || split.owner,
    name: input.name || split.name,
    fullName,
    defaultBranch: input.defaultBranch || "",
    url: input.url || input.webUrl || "",
  }
}

function jsonValue(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }
  return value
}

function emptyRepoSettings() {
  return {
    permissions: { items: [], checkedAt: "" },
    variables: { items: [], checkedAt: "" },
    webhook: {},
    plugins: { items: [], checkedAt: "" },
    runners: { items: [], checkedAt: "" },
  }
}

function repoSettingData(row) {
  const data = rowData(row) || {}
  return {
    ...data,
    key: data.key || row.key || "",
    source: data.source || row.source || "",
  }
}

function latestTimestamp(current = "", next = "") {
  if (!next) return current
  if (!current) return next
  return String(next) > String(current) ? next : current
}

function repoTaskKey(row = {}) {
  return `${String(row.gitServerId || "")}::${String(row.repositoryId || "")}`
}

function nullableDate(value) {
  return value ? new Date(value) : null
}

export {
  nowIso,
  ensureDir,
  randomId,
  normalizeBaseUrl,
  normalizeApiUrl,
  hostFromBaseUrl,
  primaryDomainFromBaseUrl,
  normalizeOauthScopes,
  normalizeAutomation,
  normalizeAgentrix,
  normalizeRunnerId,
  normalizeGitServer,
  asDate,
  timestampValue,
  rowData,
  normalizeUser,
  normalizeGitAccount,
  splitRepoFullName,
  normalizeRepoIdentity,
  jsonValue,
  emptyRepoSettings,
  repoSettingData,
  latestTimestamp,
  repoTaskKey,
  nullableDate,
}
