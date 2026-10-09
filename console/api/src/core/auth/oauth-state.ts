// @ts-nocheck
import crypto from "node:crypto"

const OAUTH_STATE_TTL_SECONDS = 10 * 60

function timingSafeEqualString(a = "", b = "") {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function oauthStateKey(store) {
  if (store && typeof store.resolveCryptoKey === 'function') {
    return store.resolveCryptoKey()
  }
  return crypto.createHash('sha256').update(String(process.env.ISSUE_FLOW_SERVICE_KEY || 'issue-flow-oauth-state')).digest()
}

function signOAuthStatePayload(store, payload) {
  return crypto
    .createHmac('sha256', oauthStateKey(store))
    .update(payload)
    .digest('base64url')
}

function signOAuthState(store, input = {}) {
  const payload = Buffer.from(JSON.stringify({
    gitServerId: input.gitServerId || '',
    returnTo: input.returnTo || '/repos',
    setupAdminEligible: Boolean(input.setupAdminEligible),
    flow: input.flow === 'install' ? 'install' : 'login',
    nonce: crypto.randomBytes(12).toString('hex'),
    exp: Date.now() + OAUTH_STATE_TTL_SECONDS * 1000,
  })).toString('base64url')
  return `${payload}.${signOAuthStatePayload(store, payload)}`
}

function verifyOAuthState(store, value = '') {
  const [payload, signature] = String(value || '').split('.')
  if (!payload || !signature) return undefined
  const expected = signOAuthStatePayload(store, payload)
  if (!timingSafeEqualString(signature, expected)) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!parsed || Number(parsed.exp || 0) < Date.now()) return undefined
    return {
      gitServerId: String(parsed.gitServerId || ''),
      returnTo: String(parsed.returnTo || '/repos'),
      setupAdminEligible: Boolean(parsed.setupAdminEligible),
      flow: parsed.flow === 'install' ? 'install' : 'login',
    }
  } catch {
    return undefined
  }
}


export { signOAuthState, verifyOAuthState, timingSafeEqualString }
