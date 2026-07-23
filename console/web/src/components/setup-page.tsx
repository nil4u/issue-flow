import { GitBranch, KeyRound } from "lucide-react"
import { useState } from "react"
import type { FormEvent } from "react"

import { GitServerSetupFields, type GitServerSetupFieldsValue } from "@/components/git-server-setup-fields"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { SetupStatus } from "@/issue-flow-model"

type SetupForm = GitServerSetupFieldsValue & {
  setupCode: string
}

const defaultForm: SetupForm = {
  setupCode: "",
  baseUrl: "",
  oauthClientId: "",
  oauthClientSecret: "",
  agentrixGitServerId: "",
  adminPat: "",
  commitAuthorName: "issue-flow",
  commitAuthorEmail: "",
}

export function SetupPage({
  status,
  loading,
  onInitialize,
}: {
  status?: SetupStatus
  loading: boolean
  onInitialize: (input: SetupForm) => Promise<void>
}) {
  const [form, setForm] = useState<SetupForm>(defaultForm)

  function update<K extends keyof SetupForm>(key: K, value: SetupForm[K]) {
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === "baseUrl" && (!current.commitAuthorEmail || current.commitAuthorEmail === defaultCommitAuthorEmail(current.baseUrl))
        ? { commitAuthorEmail: defaultCommitAuthorEmail(value) }
        : {}),
    }))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await onInitialize(form)
  }

  return (
    <main className="login-screen setup-screen">
      <section className="login-panel setup-panel">
        <div className="login-brand">
          <span className="brand-mark">IF</span>
          <strong>Issue Flow</strong>
          <small>{status?.state === "broken" ? "Complete Git server setup" : "Initial setup"}</small>
        </div>

        <form className="setup-form" onSubmit={submit}>
          <label className="setup-field">
            <span>Setup Code</span>
            <Input
              type="password"
              autoComplete="one-time-code"
              value={form.setupCode}
              onChange={(event) => update("setupCode", event.target.value)}
              required
            />
          </label>

          <GitServerSetupFields value={form} onChange={update} showDivider />

          {status && !status.setupCodeConfigured ? (
            <div className="setup-note">
              <KeyRound className="size-4" />
              <span>服务端缺少 ISSUE_FLOW_SETUP_CODE。</span>
            </div>
          ) : null}
          {status?.missing?.length ? (
            <div className="setup-note">
              <GitBranch className="size-4" />
              <span>缺少配置：{status.missing.join(", ")}</span>
            </div>
          ) : null}

          <Button type="submit" className="setup-submit" disabled={loading || status?.setupCodeConfigured === false}>
            保存并登录
          </Button>
        </form>
      </section>
    </main>
  )
}

function defaultCommitAuthorEmail(baseUrl = "") {
  try {
    const parts = new URL(String(baseUrl || "").trim()).hostname.split(".").filter(Boolean)
    const domain = parts.length >= 2 ? parts.slice(-2).join(".") : parts[0] || ""
    return domain ? `issue-flow@${domain}` : ""
  } catch {
    return ""
  }
}
