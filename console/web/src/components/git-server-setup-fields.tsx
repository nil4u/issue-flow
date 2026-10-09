import type { ReactNode } from "react"

import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"

export type GitServerSetupFieldsValue = {
  type?: string
  githubAppId?: string
  githubAppSlug?: string
  githubPrivateKey?: string
  webhookSecret?: string
  baseUrl: string
  oauthClientId: string
  oauthClientSecret: string
  agentrixGitServerId: string
  adminPat: string
  commitAuthorName: string
  commitAuthorEmail: string
}

type SetupField = keyof GitServerSetupFieldsValue

export function GitServerSetupFields({ value, onChange, showDivider = false, editing = false }: { value: GitServerSetupFieldsValue; onChange: (key: SetupField, value: string) => void; showDivider?: boolean; editing?: boolean }) {
  const github = value.type === "github"
  return (
    <>
      <Field label="Git provider">
        <select value={value.type || "gitlab"} disabled={editing} onChange={(event) => {
          onChange("type", event.currentTarget.value)
          onChange("baseUrl", event.currentTarget.value === "github" ? "https://github.com" : "")
        }}><option value="gitlab">GitLab</option><option value="github">GitHub</option></select>
      </Field>
      <Field label="Base URL">
        <Input placeholder={github ? "https://github.com" : "https://gitlab.example.com"} value={value.baseUrl} onChange={(event) => onChange("baseUrl", event.currentTarget.value)} required />
      </Field>
      {showDivider ? <div className="setup-divider" /> : null}
      <Field label="OAuth Client ID">
        <Input value={value.oauthClientId} onChange={(event) => onChange("oauthClientId", event.currentTarget.value)} required />
      </Field>
      <Field label="OAuth Client Secret">
        <Input type="password" value={value.oauthClientSecret} onChange={(event) => onChange("oauthClientSecret", event.currentTarget.value)} required={!editing} />
      </Field>
      <Field label="Agentrix Git Server ID">
        <Input value={value.agentrixGitServerId} onChange={(event) => onChange("agentrixGitServerId", event.currentTarget.value)} required={!github} />
      </Field>
      {github ? <>
        <Field label="GitHub App ID"><Input value={value.githubAppId || ""} onChange={(event) => onChange("githubAppId", event.currentTarget.value)} required /></Field>
        <Field label="GitHub App slug"><Input placeholder="issue-flow-nil4u" value={value.githubAppSlug || ""} onChange={(event) => onChange("githubAppSlug", event.currentTarget.value)} required /></Field>
        <Field label="App private key (PEM)"><Textarea rows={5} className="field-sizing-fixed h-32 min-h-32 max-h-32 resize-none overflow-y-auto font-mono text-xs" value={value.githubPrivateKey || ""} onChange={(event) => onChange("githubPrivateKey", event.currentTarget.value)} placeholder={editing ? "留空保留现值" : "粘贴下载的 PEM 文件内容"} required={!editing} /></Field>
        <Field label="Webhook secret"><Input type="password" value={value.webhookSecret || ""} onChange={(event) => onChange("webhookSecret", event.currentTarget.value)} required={!editing} /></Field>
      </> : <Field label="Admin PAT"><Input type="password" value={value.adminPat} onChange={(event) => onChange("adminPat", event.currentTarget.value)} required={!editing} /></Field>}
      <Field label="Commit Author Name">
        <Input value={value.commitAuthorName} onChange={(event) => onChange("commitAuthorName", event.currentTarget.value)} required />
      </Field>
      <Field label="Commit Author Email">
        <Input type="email" value={value.commitAuthorEmail} onChange={(event) => onChange("commitAuthorEmail", event.currentTarget.value)} required />
      </Field>
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="setup-field">
      <span>{label}</span>
      {children}
    </label>
  )
}
