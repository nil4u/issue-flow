import type { ReactNode } from "react"

import { Input } from "@/components/ui/input"

export type GitServerSetupFieldsValue = {
  baseUrl: string
  oauthClientId: string
  oauthClientSecret: string
  agentrixGitServerId: string
  adminPat: string
  commitAuthorName: string
  commitAuthorEmail: string
}

type SetupField = keyof GitServerSetupFieldsValue

export function GitServerSetupFields({ value, onChange, showDivider = false }: { value: GitServerSetupFieldsValue; onChange: (key: SetupField, value: string) => void; showDivider?: boolean }) {
  return (
    <>
      <Field label="Base URL">
        <Input placeholder="https://gitlab.example.com" value={value.baseUrl} onChange={(event) => onChange("baseUrl", event.currentTarget.value)} required />
      </Field>
      {showDivider ? <div className="setup-divider" /> : null}
      <Field label="OAuth Client ID">
        <Input value={value.oauthClientId} onChange={(event) => onChange("oauthClientId", event.currentTarget.value)} required />
      </Field>
      <Field label="OAuth Client Secret">
        <Input type="password" value={value.oauthClientSecret} onChange={(event) => onChange("oauthClientSecret", event.currentTarget.value)} required />
      </Field>
      <Field label="Agentrix Git Server ID">
        <Input value={value.agentrixGitServerId} onChange={(event) => onChange("agentrixGitServerId", event.currentTarget.value)} required />
      </Field>
      <Field label="Admin PAT">
        <Input type="password" value={value.adminPat} onChange={(event) => onChange("adminPat", event.currentTarget.value)} required />
      </Field>
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
