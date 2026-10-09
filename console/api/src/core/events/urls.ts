function webhookBaseUrl(basePublicUrl: string, env = process.env) {
  const base = String(env.ISSUE_FLOW_WEBHOOK_BASE_URL || basePublicUrl || '').trim().replace(/\/+$/, '')
  return base
}

export function githubWebhookUrl(basePublicUrl: string, env = process.env) {
  return `${webhookBaseUrl(basePublicUrl, env)}/webhooks/github`
}

export function gitlabWebhookUrl(basePublicUrl: string, repoId: string, env = process.env) {
  return `${webhookBaseUrl(basePublicUrl, env)}/webhooks/gitlab/${encodeURIComponent(repoId)}`
}

export function externallyAddressableWebhook(value: string) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password
      && !['localhost', '0.0.0.0', '[::]', '[::1]'].includes(host)
      && !host.endsWith('.localhost') && !host.startsWith('127.')
  } catch {
    return false
  }
}
