// @ts-nocheck
import crypto from 'node:crypto'
import { providerFetch } from '../provider-api.js'

export function githubError(code, status = 400) {
  return Object.assign(new Error(code), { code, status })
}

export function githubClient(server, token) {
  return { ...server, type: 'github', userToken: token, accessToken: '', adminPat: '' }
}

export function appJwt(server, now = Date.now()) {
  const app = server.githubApp || {}
  if (!app.appId || !app.privateKey) throw githubError('github_app_credentials_required')
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const seconds = Math.floor(now / 1000)
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: app.appId })}`
  try { return `${payload}.${crypto.sign('RSA-SHA256', Buffer.from(payload), app.privateKey).toString('base64url')}` }
  catch { throw githubError('github_app_private_key_invalid') }
}

export function githubAppRequest(server, method, path, body) {
  return providerFetch(githubClient(server, appJwt(server)), method, path, body)
}

export async function installationClient(server, fullName) {
  const path = fullName.split('/').map(encodeURIComponent).join('/')
  const installation = await githubAppRequest(server, 'GET', `/repos/${path}/installation`)
  if (installation.suspended_at) throw githubError('github_installation_suspended', 403)
  const result = await githubAppRequest(server, 'POST', `/app/installations/${installation.id}/access_tokens`, { repositories: [fullName.split('/').at(-1)] })
  if (!result.token) throw githubError('github_installation_token_missing', 502)
  return { client: githubClient(server, result.token), installation, token: result.token }
}

export async function githubPages(client, path, key) {
  const items = []
  for (let page = 1; ; page++) {
    const result = await providerFetch(client, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    const batch = key ? result[key] : result
    if (!Array.isArray(batch)) throw githubError('github_invalid_page', 502)
    items.push(...batch)
    if (batch.length < 100) return items
  }
}

export async function githubOAuthToken(server, parameters) {
  const response = await fetch(`${server.baseUrl}/login/oauth/access_token`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: server.oauth.clientId, client_secret: server.oauth.clientSecret, ...parameters }),
  })
  const result = await response.json()
  if (!response.ok || result.error || !result.access_token) throw githubError('github_oauth_token_exchange_failed', response.ok ? 401 : response.status)
  return result
}

export function githubProject(repo) {
  return {
    id: String(repo.id), serverRepoId: String(repo.id), name: repo.name,
    fullName: repo.full_name, pathWithNamespace: repo.full_name, projectPath: repo.full_name,
    defaultBranch: repo.default_branch || 'main', webUrl: repo.html_url, url: repo.html_url,
    owner: repo.owner?.login, visibility: repo.visibility || (repo.private ? 'private' : 'public'),
    canInstall: Boolean(repo.permissions?.admin), permissions: repo.permissions || {},
  }
}

export async function discoverGithubRepositories(server, token) {
  const client = githubClient(server, token)
  const installations = (await githubPages(client, '/user/installations', 'installations'))
    .filter((installation) => !installation.app_id || String(installation.app_id) === String(server.githubApp.appId))
  const active = installations.filter((installation) => !installation.suspended_at)
  const projects = new Map()
  for (const installation of active) {
    const repos = await githubPages(client, `/user/installations/${installation.id}/repositories`, 'repositories')
    for (const repo of repos) projects.set(String(repo.id), { ...githubProject(repo), installationId: String(installation.id) })
  }
  const status = projects.size ? 'connected' : !installations.length ? 'needs_authorization' : !active.length ? 'suspended' : 'no_repositories'
  return {
    projects: [...projects.values()],
    connection: { status, repositoryCount: projects.size, installationCount: installations.length },
  }
}

export async function listGithubProjects(server, token) {
  return (await discoverGithubRepositories(server, token)).projects
}

export function githubInstallUrl(server) {
  return server.githubApp?.slug ? `${server.baseUrl}/apps/${encodeURIComponent(server.githubApp.slug)}/installations/new` : `${server.baseUrl}/settings/installations`
}
