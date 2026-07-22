import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { Loader2 } from "lucide-react"

import { Textarea } from "@/components/ui/textarea"
import { api } from "@/issue-flow-model"

type MentionUser = { id: string; username: string; name: string; avatarUrl: string; url: string; bot: boolean }
type MentionRange = { start: number; end: number; query: string }

const mentionUsersCache = new Map<string, Promise<MentionUser[]>>()

function loadMentionUsers(endpoint: string) {
  if (!mentionUsersCache.has(endpoint)) {
    mentionUsersCache.set(endpoint, api<{ users?: MentionUser[] }>(endpoint).then((result) => result.users || []).catch(() => []))
  }
  return mentionUsersCache.get(endpoint) as Promise<MentionUser[]>
}

export function ProviderMarkdown({ html, fallback }: { html?: string; fallback: string }) {
  return html ? <div className="gh-markdown" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="gh-markdown"><p>{fallback}</p></div>
}

export function ProviderMarkdownEditor({ endpoint, mentionsEndpoint, value, placeholder, disabled = false, onChange }: { endpoint: string; mentionsEndpoint?: string; value: string; placeholder: string; disabled?: boolean; onChange: (value: string) => void }) {
  const [mode, setMode] = useState<"write" | "preview">("write")
  const [previewHtml, setPreviewHtml] = useState("")
  const [previewing, setPreviewing] = useState(false)
  const [mentionRange, setMentionRange] = useState<MentionRange>()
  const [mentionUsers, setMentionUsers] = useState<MentionUser[]>([])
  const [mentionsLoading, setMentionsLoading] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const mentionCandidates = useMemo(() => {
    if (!mentionRange) return []
    const query = mentionRange.query.toLowerCase()
    return mentionUsers.filter((user) => !query || user.username.toLowerCase().includes(query) || user.name.toLowerCase().includes(query)).slice(0, 8)
  }, [mentionRange, mentionUsers])

  useEffect(() => {
    if (!mentionsEndpoint || !mentionRange || mentionUsers.length) return
    let active = true
    setMentionsLoading(true)
    void loadMentionUsers(mentionsEndpoint).then((users) => { if (active) setMentionUsers(users) }).finally(() => { if (active) setMentionsLoading(false) })
    return () => { active = false }
  }, [mentionRange, mentionUsers.length, mentionsEndpoint])

  function updateMention(nextValue: string, cursor: number) {
    if (!mentionsEndpoint) return
    const match = nextValue.slice(0, cursor).match(/(?:^|\s)@([\w.-]*)$/)
    if (!match) { setMentionRange(undefined); return }
    const query = match[1]
    setMentionRange({ start: cursor - query.length - 1, end: cursor, query })
    setMentionIndex(0)
  }

  function selectMention(user: MentionUser) {
    if (!mentionRange) return
    const insertion = `@${user.username} `
    const nextValue = `${value.slice(0, mentionRange.start)}${insertion}${value.slice(mentionRange.end)}`
    const cursor = mentionRange.start + insertion.length
    onChange(nextValue)
    setMentionRange(undefined)
    requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(cursor, cursor) })
  }

  function handleMentionKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (!mentionRange || !mentionCandidates.length) return
    if (event.key === "ArrowDown") { event.preventDefault(); setMentionIndex((current) => (current + 1) % mentionCandidates.length) }
    else if (event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length) }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); selectMention(mentionCandidates[mentionIndex] || mentionCandidates[0]) }
    else if (event.key === "Escape") { event.preventDefault(); setMentionRange(undefined) }
  }

  async function showPreview() {
    setMode("preview")
    if (!value.trim()) { setPreviewHtml(""); return }
    setPreviewing(true)
    try { setPreviewHtml((await api<{ html?: string }>(endpoint, { method: "POST", body: JSON.stringify({ body: value }) })).html || "") }
    finally { setPreviewing(false) }
  }

  return <div className="issue-markdown-editor"><div className="issue-editor-tabs"><button type="button" className={mode === "write" ? "is-active" : ""} onClick={() => setMode("write")}>Write</button><button type="button" className={mode === "preview" ? "is-active" : ""} onClick={() => void showPreview()}>Preview</button></div><div className="issue-editor-body">{mode === "write" ? <><Textarea ref={textareaRef} value={value} onChange={(event) => { const nextValue = event.currentTarget.value; onChange(nextValue); updateMention(nextValue, event.currentTarget.selectionStart) }} onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={handleMentionKeyDown} placeholder={placeholder} disabled={disabled} />{mentionRange ? <div className="gh-mention-menu">{mentionsLoading ? <div className="gh-mention-empty"><Loader2 className="size-4 animate-spin" />Loading users…</div> : mentionCandidates.length ? mentionCandidates.map((user, index) => <button key={user.username} type="button" className={index === mentionIndex ? "is-active" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => selectMention(user)}><MentionAvatar user={user} /><span><strong>@{user.username}</strong><small>{user.name}</small></span>{user.bot ? <em>Bot</em> : null}</button>) : <div className="gh-mention-empty">No matching users</div>}</div> : null}</> : previewing ? <div className="issue-editor-empty"><Loader2 className="size-4 animate-spin" />Rendering preview…</div> : previewHtml ? <ProviderMarkdown html={previewHtml} fallback="" /> : <div className="issue-editor-empty">Nothing to preview.</div>}</div></div>
}

function MentionAvatar({ user }: { user: MentionUser }) {
  const name = user.name || user.username || "?"
  return user.avatarUrl ? <img className="gh-avatar" src={user.avatarUrl} alt="" /> : <span className="gh-avatar">{name.slice(0, 1)}</span>
}
