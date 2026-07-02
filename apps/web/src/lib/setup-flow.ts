import { api, type GitServer } from "@/issue-flow-model"

export type SetupInitializeInput = {
  setupCode: string
  id: string
  name: string
  baseUrl: string
  apiUrl: string
  oauthClientId: string
  oauthClientSecret: string
  oauthRedirectUri: string
  oauthScopes: string
  webhookSecret: string
  agentrixGitServerId: string
  adminPat: string
}

export async function initializeIssueFlowSetup(input: SetupInitializeInput) {
  const body = await api<{ gitServer: GitServer }>("/api/setup/initialize", {
    method: "POST",
    body: JSON.stringify({
      setupCode: input.setupCode,
      id: input.id,
      type: "gitlab",
      name: input.name,
      baseUrl: input.baseUrl,
      apiUrl: input.apiUrl,
      oauth: {
        clientId: input.oauthClientId,
        clientSecret: input.oauthClientSecret,
        redirectUri: input.oauthRedirectUri,
        scopes: input.oauthScopes,
      },
      webhook: {
        secret: input.webhookSecret,
      },
      agentrixGitServerId: input.agentrixGitServerId,
      adminPat: input.adminPat,
    }),
  })
  return body.gitServer
}
