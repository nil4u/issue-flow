// @ts-nocheck
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { db as prismaDb, prismaClient } from "../../storage/db.js"
import { ensureDir } from "./shared.js"

const DEFAULT_STATE_DIR = ".issue-flow-service"

class StoreBase {
  constructor(options = {}) {
    const stateDir = path.resolve(process.cwd(), DEFAULT_STATE_DIR)
    this.stateDir = options.stateDir || process.env.ISSUE_FLOW_SERVICE_STATE_DIR || stateDir
    this.keyPath = options.keyPath || process.env.ISSUE_FLOW_SERVICE_KEY_FILE || path.join(this.stateDir, "key")
    this.key = options.key || process.env.ISSUE_FLOW_SERVICE_KEY || ""
    this.db = options.db || prismaDb
    this.ownsDb = !options.db
    this.metricsSchema = options.metricsSchema || process.env.ISSUE_FLOW_DB_SCHEMA || ""
    this.issueStatsDebounceMs = Number(options.issueStatsDebounceMs ?? process.env.ISSUE_FLOW_STATS_DEBOUNCE_MS ?? 2000)
    this.pendingIssueStatsRebuilds = new Map()
    this.issueStatsRebuildTimer = null
    this.issueStatsRebuildRun = Promise.resolve()
    this.ready = Promise.resolve()
  }

  async close() {
    await this.flushIssueStatsRebuilds()
    if (this.ownsDb) {
      await prismaClient.$disconnect()
    }
  }

  resolveCryptoKey() {
    const explicit = String(this.key || "").trim()
    if (explicit) {
      const hex = explicit.match(/^[0-9a-f]{64}$/i) ? Buffer.from(explicit, "hex") : undefined
      if (hex) return hex
      return crypto.createHash("sha256").update(explicit).digest()
    }

    ensureDir(this.stateDir)
    if (!fs.existsSync(this.keyPath)) {
      fs.writeFileSync(this.keyPath, `${crypto.randomBytes(32).toString("hex")}\n`, { mode: 0o600 })
    }
    return Buffer.from(fs.readFileSync(this.keyPath, "utf8").trim(), "hex")
  }

  encrypt(value) {
    if (!value) return ""
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", this.resolveCryptoKey(), iv)
    const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()])
    const tag = cipher.getAuthTag()
    return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`
  }

  decrypt(value) {
    if (!value) return ""
    const [version, iv, tag, ciphertext] = String(value).split(":")
    if (version !== "v1" || !iv || !tag || !ciphertext) {
      throw new Error("Unsupported encrypted credential format")
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.resolveCryptoKey(), Buffer.from(iv, "base64"))
    decipher.setAuthTag(Buffer.from(tag, "base64"))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8")
  }
}

export { StoreBase }
