// @ts-nocheck
import crypto from 'node:crypto'

const CONSOLE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000  // 30 天
const TOUCH_INTERVAL_MS = 60 * 60 * 1000                 // last_seen 节流:1 小时

function newConsoleSessionToken() {
  return crypto.randomBytes(32).toString('base64url')    // 256-bit,cookie 里只存这个
}

function hashConsoleSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

export {
  CONSOLE_SESSION_TTL_MS,
  TOUCH_INTERVAL_MS,
  hashConsoleSessionToken,
  newConsoleSessionToken,
}
