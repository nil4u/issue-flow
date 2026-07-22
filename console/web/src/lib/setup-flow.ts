import { api, type GitServer } from "@/issue-flow-model"

export type SetupInitializeInput = {
  setupCode: string
  baseUrl: string
  oauthClientId: string
  oauthClientSecret: string
  agentrixGitServerId: string
  adminPat: string
  commitAuthorName: string
  commitAuthorEmail: string
}

export type SetupInitializeResult = {
  gitServer: GitServer
  authorizeUrl: string
}

export async function initializeIssueFlowSetup(input: SetupInitializeInput) {
  const body = await api<SetupInitializeResult>("/api/setup/initialize", {
    method: "POST",
    body: JSON.stringify({
      setupCode: input.setupCode,
      type: "gitlab",
      baseUrl: input.baseUrl,
      oauth: {
        clientId: input.oauthClientId,
        clientSecret: input.oauthClientSecret,
      },
      agentrixGitServerId: input.agentrixGitServerId,
      adminPat: input.adminPat,
      commitAuthor: {
        name: input.commitAuthorName,
        email: input.commitAuthorEmail,
      },
    }),
  })
  return body
}
