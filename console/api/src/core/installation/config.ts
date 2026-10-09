import { externallyAddressableWebhook } from '../events/urls.js'

type PublicEnvironment = { ISSUE_FLOW_PUBLIC_BASE_URL?: string; ISSUE_FLOW_BASE_URL?: string; ISSUE_FLOW_WEBHOOK_BASE_URL?: string }

export function publicIssueFlowBaseUrl(basePublicUrl = '', env: PublicEnvironment = process.env) {
  const configured = String(env.ISSUE_FLOW_PUBLIC_BASE_URL || '').trim()
  const fallback = String(basePublicUrl || env.ISSUE_FLOW_BASE_URL || '').trim()
  const value = configured || (externallyAddressableWebhook(fallback) ? fallback : String(env.ISSUE_FLOW_WEBHOOK_BASE_URL || '').trim())
  if (!externallyAddressableWebhook(value) || new URL(value).search || new URL(value).hash) {
    throw Object.assign(new Error('请配置 ISSUE_FLOW_PUBLIC_BASE_URL 为任务和浏览器可访问的 Issue Flow 公网地址。'), { status: 400, code: 'issue_flow_public_base_url_required' })
  }
  return value.replace(/\/+$/, '')
}
