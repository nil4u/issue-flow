// @ts-nocheck

function providerApiError(message, status = 500, details = undefined) {
  const error = new Error(message)
  error.status = status
  error.details = details
  return error
}

function trimSlash(value = "") {
  return String(value || "").replace(/\/+$/, "")
}

function providerToken(server = {}) {
  return server.userToken || server.accessToken || server.botPat || server.adminPat || ""
}

function providerAuthHeaders(server = {}) {
  const token = providerToken(server)
  if (!token) throw providerApiError("current user Git credential is required", 401)
  if (server.type === "gitlab" && String(server.tokenAuth || "").toLowerCase() === "private-token") {
    return { "PRIVATE-TOKEN": token }
  }
  return { Authorization: `Bearer ${token}` }
}

async function providerFetch(server, method, pathname, body = undefined) {
  const response = await fetch(`${trimSlash(server.apiUrl)}${pathname}`, {
    method,
    headers: {
      Accept: server.type === "github" ? "application/vnd.github+json" : "application/json",
      ...providerAuthHeaders(server),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(server.type === "github" ? { "X-GitHub-Api-Version": "2022-11-28" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : undefined } catch { parsed = text }
  if (!response.ok) throw providerApiError(`${server.type} API ${method} ${pathname} failed`, response.status, parsed)
  return parsed
}

function githubRepoPath(repo) {
  return `/repos/${String(repo.fullName || "").split("/").map(encodeURIComponent).join("/")}`
}

function gitlabProjectPath(repo) {
  return `/projects/${encodeURIComponent(repo.serverRepoId || repo.fullName)}`
}

async function renderProviderMarkdown(server, repo, markdown) {
  if (!markdown) return ""
  if (server.type === "github") {
    return String(await providerFetch(server, "POST", "/markdown", { text: markdown, mode: "gfm", context: repo.fullName }) || "")
  }
  if (server.type === "gitlab") {
    const result = await providerFetch(server, "POST", "/markdown", { text: markdown, gfm: true, project: repo.fullName })
    return String(result && result.html || "")
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

export { githubRepoPath, gitlabProjectPath, providerApiError, providerFetch, renderProviderMarkdown }
