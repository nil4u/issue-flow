import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Check, ExternalLink, GitBranch, KeyRound, Link2, Loader2, Plus, Save, Server, ShieldCheck, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { AgentrixPanel } from "@/components/agentrix-panel"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { api, type AgentrixDefaults, type GitServer, type UserGitAccount, type UserGitPat, type UserSession } from "@/issue-flow-model"
import { notifyError } from "@/lib/errors"

type SettingsSection = "account" | "agentrix" | "git-servers"

type GitServerForm = {
  id: string
  type: string
  name: string
  baseUrl: string
  apiUrl: string
  tokenAuth: string
  oauthClientId: string
  oauthClientSecret: string
  oauthScopes: string
  webhookSecret: string
  agentrixGitServerId: string
  adminPat: string
  commitAuthorName: string
  commitAuthorEmail: string
}

const emptyGitServerForm: GitServerForm = {
  id: "",
  type: "gitlab",
  name: "",
  baseUrl: "",
  apiUrl: "",
  tokenAuth: "bearer",
  oauthClientId: "",
  oauthClientSecret: "",
  oauthScopes: "api read_repository write_repository openid profile email",
  webhookSecret: "",
  agentrixGitServerId: "",
  adminPat: "",
  commitAuthorName: "issue-flow",
  commitAuthorEmail: "",
}

export function UserSettings({
  userSession,
  gitServers,
  activeSection,
  pendingGitServerId,
  savingGitServerId,
  deletingGitServerId,
  onSelectSection,
  onConnectGitServer,
  onSaveGitServer,
  onDeleteGitServer,
}: {
  userSession: UserSession
  gitServers: GitServer[]
  activeSection: SettingsSection
  pendingGitServerId: string
  savingGitServerId: string
  deletingGitServerId: string
  onSelectSection: (section: SettingsSection) => void
  onConnectGitServer: (gitServerId: string) => void
  onSaveGitServer: (input: GitServer) => Promise<unknown>
  onDeleteGitServer: (gitServerId: string) => Promise<unknown>
}) {
  const isAdmin = userSession.user && !("username" in userSession.user) && userSession.user.role === "admin"
  const section = !isAdmin && activeSection === "git-servers" ? "account" : activeSection
  const adminSection = section === "git-servers"

  return (
    <div className="settings-panel">
      <header className="settings-titlebar">
        {adminSection ? (
          <div className="settings-page-title">
            <Server className="size-4" />
            <strong>Git servers</strong>
          </div>
        ) : (
          <div className="settings-tabs" role="tablist" aria-label="用户设置">
            <button type="button" className={`settings-tab ${section === "account" ? "active" : ""}`} onClick={() => onSelectSection("account")}>
              账户
            </button>
            <button type="button" className={`settings-tab ${section === "agentrix" ? "active" : ""}`} onClick={() => onSelectSection("agentrix")}>
              Agentrix
            </button>
          </div>
        )}
      </header>

      <div className="settings-body">
        {section === "git-servers" ? (
          <GitServerAdmin
            gitServers={gitServers}
            savingGitServerId={savingGitServerId}
            deletingGitServerId={deletingGitServerId}
            onSaveGitServer={onSaveGitServer}
            onDeleteGitServer={onDeleteGitServer}
          />
        ) : section === "agentrix" ? (
          <AgentrixPanel userSession={userSession} gitServers={gitServers} onConnectGitServer={onConnectGitServer} onOpenAccount={() => onSelectSection("account")} />
        ) : (
          <AccountSettings userSession={userSession} gitServers={gitServers} pendingGitServerId={pendingGitServerId} onConnectGitServer={onConnectGitServer} />
        )}
      </div>
    </div>
  )
}

function AccountSettings({
  userSession,
  gitServers,
  pendingGitServerId,
  onConnectGitServer,
}: {
  userSession: UserSession
  gitServers: GitServer[]
  pendingGitServerId: string
  onConnectGitServer: (gitServerId: string) => void
}) {
  const accountByServerId = new Map(
    (userSession.accounts || [])
      .filter((item) => item.account?.gitServerId || item.gitServer?.id || item.session?.gitServerId)
      .map((item) => [item.account?.gitServerId || item.gitServer?.id || item.session?.gitServerId || "", item.account])
  )
  const user = userSession.user
  const displayName = userDisplayName(user)

  return (
    <section className="settings-content">
      <div className="account-summary">
        <span className="account-avatar">{displayName.slice(0, 1).toUpperCase() || "U"}</span>
        <span>
          <strong>{displayName}</strong>
          <small>{userEmail(user) || "通过 Git 账号登录 issue-flow"}</small>
        </span>
      </div>

      <AgentrixAccountGroup userSession={userSession} gitServers={gitServers} />

      <div className="account-group">
        <header>
          <strong>关联 Git 账号</strong>
          <span>
            {connectedCount(accountByServerId, gitServers)} / {gitServers.length}
          </span>
        </header>
        <div className="account-list">
          {gitServers.map((server) => {
            const account = accountByServerId.get(server.id)
            const connected = Boolean(account)
            const unsupported = server.type !== "gitlab"
            return (
              <div className="account-row" key={server.id}>
                <span className="account-provider-icon">{providerIcon(server.type)}</span>
                <span className="account-row-copy">
                  <strong>{accountTitle(account, server)}</strong>
                  <small>{serverLabel(server, account)}</small>
                </span>
                <span className={`account-status ${connected ? "connected" : ""}`}>
                  {connected ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
                  {connected ? "已关联" : "未关联"}
                </span>
                <Button size="sm" variant={connected ? "outline" : "default"} disabled={pendingGitServerId === server.id || unsupported} onClick={() => onConnectGitServer(server.id)}>
                  {pendingGitServerId === server.id && <Loader2 className="size-4 animate-spin" />}
                  {connected ? "重新关联" : unsupported ? "待支持" : "关联"}
                </Button>
              </div>
            )
          })}
          {gitServers.length === 0 && <div className="account-empty">还没有配置 Git server</div>}
        </div>
      </div>

      <GitPatAccountGroup userSession={userSession} gitServers={gitServers} />
    </section>
  )
}

function GitPatAccountGroup({ gitServers, userSession }: { gitServers: GitServer[]; userSession: UserSession }) {
  const gitlabServers = gitServers.filter((server) => server.type === "gitlab")
  const linkedServerIds = new Set((userSession.accounts || []).map((item) => item.account?.gitServerId || item.gitServer?.id || item.session?.gitServerId || "").filter(Boolean))
  const [pats, setPats] = useState<Record<string, UserGitPat>>({})
  const [editingServer, setEditingServer] = useState<GitServer>()
  const [token, setToken] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const selectedPat = editingServer ? pats[editingServer.id] : undefined

  useEffect(() => {
    let active = true
    void api<{ pats: UserGitPat[] }>("/api/user/git-pats")
      .then((body) => {
        if (active) setPats(Object.fromEntries((body.pats || []).map((pat) => [pat.gitServerId, pat])))
      })
      .catch((error) => {
        if (active) notifyError(error, "加载 Git PAT 失败")
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [userSession.accounts])

  function editPat(server?: GitServer) {
    setEditingServer(server)
    setToken("")
  }

  async function savePat() {
    if (!editingServer || (!token.trim() && !selectedPat?.tokenFingerprint)) return
    setSaving(true)
    try {
      const body = await api<{ pat: UserGitPat }>(`/api/user/git-pats/${encodeURIComponent(editingServer.id)}`, {
        method: "POST",
        body: JSON.stringify(token.trim() ? { token: token.trim() } : {}),
      })
      setPats((current) => ({ ...current, [editingServer.id]: body.pat }))
      setToken("")
      setEditingServer(undefined)
      toast.success("Git PAT 已校验并保存")
    } catch (error) {
      notifyError(error, "Git PAT 校验失败")
    } finally {
      setSaving(false)
    }
  }

  async function deletePat() {
    if (!editingServer || !selectedPat?.tokenFingerprint) return
    setDeleting(true)
    try {
      const body = await api<{ pat: UserGitPat }>(`/api/user/git-pats/${encodeURIComponent(editingServer.id)}`, { method: "DELETE" })
      setPats((current) => {
        return { ...current, [editingServer.id]: body.pat }
      })
      setToken("")
      setEditingServer(undefined)
      toast.success("Git PAT 已删除")
    } catch (error) {
      notifyError(error, "删除 Git PAT 失败")
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="account-group git-pat-account-group">
      <header>
        <strong>Personal access tokens</strong>
        <span>
          {Object.values(pats).filter((pat) => pat.tokenFingerprint).length} / {gitlabServers.length}
        </span>
      </header>
      <div className="account-list">
        {gitlabServers.map((server) => {
          const pat = pats[server.id]
          const linked = linkedServerIds.has(server.id)
          const saved = Boolean(pat?.tokenFingerprint)
          return (
            <div className="account-row git-pat-account-row" key={server.id}>
              <span className={`account-provider-icon ${saved ? "connected" : "unlinked"}`}>
                <ShieldCheck className="size-4" />
              </span>
              <span className="account-row-copy">
                <strong>{server.name || server.baseUrl || server.id}</strong>
                <small>{saved ? patSummary(pat) : linked ? "尚未保存 PAT" : "请先关联 Git 账号"}</small>
              </span>
              <span className={`account-status ${saved ? "connected" : ""}`}>
                {loading ? <Loader2 className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" /> : <KeyRound className="size-3.5" />}
                {saved ? "可用" : "未配置"}
              </span>
              <Button type="button" size="sm" variant={saved ? "outline" : "default"} disabled={!linked || loading} onClick={() => editPat(server)}>
                {saved ? "管理" : "添加"}
              </Button>
            </div>
          )
        })}
        {gitlabServers.length === 0 ? <div className="account-empty">还没有 GitLab server</div> : null}
      </div>

      <Dialog open={Boolean(editingServer)} onOpenChange={(open) => !open && editPat(undefined)}>
        <DialogContent className="agentrix-account-dialog git-pat-dialog">
          <DialogHeader>
            <DialogTitle>{selectedPat?.tokenFingerprint ? "管理 Git PAT" : "添加 Git PAT"}</DialogTitle>
          </DialogHeader>
          <form
            className="agentrix-account-dialog-body"
            onSubmit={(event) => {
              event.preventDefault()
              void savePat()
            }}
          >
            <div className="git-pat-dialog-copy">
              <strong>{editingServer?.name || editingServer?.baseUrl || editingServer?.id}</strong>
              <span>需要 api、read_repository、write_repository 权限。</span>
            </div>
            <label className="setup-field">
              <span>Personal access token</span>
              <div className="git-pat-input-row">
                <Input
                  autoFocus
                  aria-label="Git personal access token"
                  type="password"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  value={token}
                  onChange={(event) => setToken(event.currentTarget.value)}
                  placeholder={selectedPat?.tokenFingerprint ? "留空以继续使用已保存的 PAT" : "粘贴 GitLab PAT"}
                />
                {selectedPat?.createUrl ? (
                  <a className="git-pat-external-action" href={selectedPat.createUrl} target="_blank" rel="noreferrer" aria-label="在 GitLab 生成 PAT" title="在 GitLab 生成 PAT">
                    <ExternalLink className="size-4" />
                  </a>
                ) : null}
              </div>
            </label>
            <div className="git-pat-dialog-actions">
              {selectedPat?.tokenFingerprint ? (
                <Button type="button" variant="destructive" disabled={saving || deleting} onClick={() => void deletePat()}>
                  {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  删除
                </Button>
              ) : (
                <span />
              )}
              <Button type="submit" disabled={saving || deleting || (!token.trim() && !selectedPat?.tokenFingerprint)}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                校验并保存
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function patSummary(pat?: UserGitPat) {
  const owner = pat?.gitlabUsername ? `${pat.gitlabUsername} · ` : ""
  return `${owner}${(pat?.scopes || []).join(" · ")}`
}

function AgentrixAccountGroup({ gitServers, userSession }: { gitServers: GitServer[]; userSession: UserSession }) {
  const gitServerId = agentrixContextGitServerId(userSession, gitServers)
  const [config, setConfig] = useState<AgentrixDefaults>()
  const [apiKey, setApiKey] = useState("")
  const [editingApiKey, setEditingApiKey] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const agentrix = config?.agentrix
  const user = agentrix?.user
  const connected = Boolean(agentrix?.apiKeyFingerprint)
  const title = connected ? user?.username || user?.email || user?.id || "Agentrix" : "Agentrix"
  const detail = connected ? user?.email || "" : ""

  useEffect(() => {
    if (!gitServerId) {
      setConfig(undefined)
      setEditingApiKey(false)
      return
    }
    void loadConfig()
  }, [gitServerId])

  function setEditing(open: boolean) {
    setEditingApiKey(open)
    if (open) setApiKey("")
  }

  async function loadConfig() {
    if (!gitServerId) return
    setLoading(true)
    try {
      const body = await api<{ config: AgentrixDefaults }>(`/api/user/agentrix-config?gitServerId=${encodeURIComponent(gitServerId)}`)
      setConfig(body.config)
    } catch (error) {
      notifyError(error, "加载 Agentrix 账号失败")
    } finally {
      setLoading(false)
    }
  }

  async function saveApiKey() {
    if (!gitServerId || !apiKey.trim()) return
    setSaving(true)
    try {
      const body = await api<{ config: AgentrixDefaults }>("/api/user/agentrix-config", {
        method: "POST",
        body: JSON.stringify({
          gitServerId,
          agentrix: {
            apiKey: apiKey.trim(),
          },
        }),
      })
      setConfig(body.config)
      setApiKey("")
      setEditing(false)
      toast.success("Agentrix API key 已校验并保存")
    } catch (error) {
      notifyError(error, "Agentrix API key 校验失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="account-group agentrix-account-group">
      <header>
        <strong>Agentrix 账号</strong>
      </header>
      <div className="account-list">
        {!gitServerId ? (
          <div className="account-empty">先关联一个 GitLab 账号后再关联 Agentrix</div>
        ) : (
          <div className={`account-row agentrix-account-row ${connected ? "linked" : "unlinked"}`}>
            <span className={`account-provider-icon ${connected ? "connected" : "unlinked"}`}>{connected ? <KeyRound className="size-4" /> : <Link2 className="size-4" />}</span>
            <span className="account-row-copy">
              <strong>{title}</strong>
              {detail ? <small>{detail}</small> : null}
            </span>
            <span className={`account-status ${connected ? "connected" : ""}`}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : connected ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
              {connected ? "已关联" : "未关联"}
            </span>
            <Button type="button" className="agentrix-account-action" size="sm" variant={connected ? "outline" : "default"} disabled={loading} onClick={() => setEditing(true)}>
              {connected ? "重新关联" : "关联"}
            </Button>
          </div>
        )}
      </div>
      <Dialog open={editingApiKey} onOpenChange={setEditing}>
        <DialogContent className="agentrix-account-dialog">
          <DialogHeader>
            <DialogTitle>Agentrix API key</DialogTitle>
          </DialogHeader>
          <form
            className="agentrix-account-dialog-body"
            onSubmit={(event) => {
              event.preventDefault()
              void saveApiKey()
            }}
          >
            <Input
              autoFocus
              aria-label="Agentrix API key"
              className="agentrix-account-input"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              placeholder="粘贴 Agentrix API key"
            />
            <div className="agentrix-account-dialog-actions">
              <Button type="submit" disabled={saving || !apiKey.trim()}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                保存
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function GitServerAdmin({
  gitServers,
  savingGitServerId,
  deletingGitServerId,
  onSaveGitServer,
  onDeleteGitServer,
}: {
  gitServers: GitServer[]
  savingGitServerId: string
  deletingGitServerId: string
  onSaveGitServer: (input: GitServer) => Promise<unknown>
  onDeleteGitServer: (gitServerId: string) => Promise<unknown>
}) {
  const [selectedId, setSelectedId] = useState(gitServers[0]?.id || "")
  const selectedServer = useMemo(() => gitServers.find((server) => server.id === selectedId), [gitServers, selectedId])
  const [form, setForm] = useState<GitServerForm>(() => formFromGitServer(selectedServer))
  const isNew = !selectedServer
  const busy = Boolean(savingGitServerId || deletingGitServerId)
  const saving = savingGitServerId === (form.id || "new")

  useEffect(() => {
    if (selectedId && gitServers.some((server) => server.id === selectedId)) return
    setSelectedId(gitServers[0]?.id || "")
  }, [gitServers, selectedId])

  useEffect(() => {
    setForm(formFromGitServer(selectedServer))
  }, [selectedServer?.id])

  function update<K extends keyof GitServerForm>(key: K, value: GitServerForm[K]) {
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === "baseUrl" && !current.apiUrl ? { apiUrl: defaultApiUrl(value) } : {}),
      ...(key === "baseUrl" && (!current.commitAuthorEmail || current.commitAuthorEmail === defaultCommitAuthorEmail(current.baseUrl)) ? { commitAuthorEmail: defaultCommitAuthorEmail(value) } : {}),
    }))
  }

  async function submit() {
    await onSaveGitServer(payloadFromForm(form))
    setSelectedId(form.id)
  }

  async function remove() {
    if (!selectedServer) return
    const confirmed = window.confirm(`删除 Git server "${selectedServer.name || selectedServer.id}"？`)
    if (!confirmed) return
    await onDeleteGitServer(selectedServer.id)
  }

  return (
    <section className="settings-content git-server-admin">
      <div className="git-server-layout">
        <aside className="git-server-list" aria-label="Git servers">
          <header>
            <strong>Git servers</strong>
            <Button size="sm" variant="outline" onClick={() => setSelectedId("")}>
              <Plus className="size-3.5" />
              添加
            </Button>
          </header>
          <div className="git-server-items">
            {gitServers.map((server) => (
              <button type="button" key={server.id} className={`git-server-item ${server.id === selectedId ? "active" : ""}`} onClick={() => setSelectedId(server.id)}>
                <span className="account-provider-icon">
                  <Server className="size-4" />
                </span>
                <span>
                  <strong>{server.name || server.id}</strong>
                  <small>{server.baseUrl || server.type}</small>
                </span>
              </button>
            ))}
            {gitServers.length === 0 && <div className="account-empty">还没有 Git server</div>}
          </div>
        </aside>

        <form
          className="git-server-form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <header>
            <span>
              <strong>{isNew ? "添加 Git server" : "修改 Git server"}</strong>
              <small>敏感字段留空时会保留已有值。</small>
            </span>
            <div className="git-server-form-actions">
              {!isNew && (
                <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
                  {deletingGitServerId === selectedServer.id ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  删除
                </Button>
              )}
              <Button type="submit" size="sm" disabled={busy || !form.id || !form.baseUrl || !form.commitAuthorName || !form.commitAuthorEmail}>
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                保存
              </Button>
            </div>
          </header>

          <div className="git-server-fields">
            <Field label="ID">
              <Input value={form.id} disabled={!isNew} onChange={(event) => update("id", event.currentTarget.value)} placeholder="gitlab-main" />
            </Field>
            <Field label="类型">
              <select value={form.type} onChange={(event) => update("type", event.currentTarget.value)}>
                <option value="gitlab">gitlab</option>
                <option value="github">github</option>
              </select>
            </Field>
            <Field label="名称">
              <Input value={form.name} onChange={(event) => update("name", event.currentTarget.value)} placeholder="GitLab" />
            </Field>
            <Field label="Token auth">
              <select value={form.tokenAuth} onChange={(event) => update("tokenAuth", event.currentTarget.value)}>
                <option value="bearer">bearer</option>
                <option value="private-token">private-token</option>
              </select>
            </Field>
            <Field label="Base URL">
              <Input value={form.baseUrl} onChange={(event) => update("baseUrl", event.currentTarget.value)} placeholder="https://gitlab.example.com" />
            </Field>
            <Field label="API URL">
              <Input value={form.apiUrl} onChange={(event) => update("apiUrl", event.currentTarget.value)} placeholder="https://gitlab.example.com/api/v4" />
            </Field>
            <Field label="Commit author name">
              <Input value={form.commitAuthorName} onChange={(event) => update("commitAuthorName", event.currentTarget.value)} />
            </Field>
            <Field label="Commit author email">
              <Input type="email" value={form.commitAuthorEmail} onChange={(event) => update("commitAuthorEmail", event.currentTarget.value)} />
            </Field>
            <Field label="OAuth client ID">
              <Input value={form.oauthClientId} onChange={(event) => update("oauthClientId", event.currentTarget.value)} />
            </Field>
            <Field label={`OAuth secret${fingerprintLabel(selectedServer?.oauth?.clientSecretFingerprint)}`}>
              <Input type="password" value={form.oauthClientSecret} onChange={(event) => update("oauthClientSecret", event.currentTarget.value)} placeholder="留空保留现值" />
            </Field>
            <Field label="OAuth scopes" wide>
              <Input value={form.oauthScopes} onChange={(event) => update("oauthScopes", event.currentTarget.value)} />
            </Field>
            <Field label={`Webhook secret${fingerprintLabel(selectedServer?.webhook?.secretFingerprint)}`}>
              <Input type="password" value={form.webhookSecret} onChange={(event) => update("webhookSecret", event.currentTarget.value)} placeholder="留空保留现值" />
            </Field>
            <Field label="Agentrix Git server ID">
              <Input value={form.agentrixGitServerId} onChange={(event) => update("agentrixGitServerId", event.currentTarget.value)} />
            </Field>
            <Field label={`Admin PAT${fingerprintLabel(selectedServer?.adminPatFingerprint)}`} wide>
              <Input type="password" value={form.adminPat} onChange={(event) => update("adminPat", event.currentTarget.value)} placeholder="留空保留现值" />
            </Field>
          </div>
        </form>
      </div>
    </section>
  )
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`setup-field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function formFromGitServer(server?: GitServer): GitServerForm {
  if (!server) return emptyGitServerForm
  return {
    id: server.id || "",
    type: server.type || "gitlab",
    name: server.name || "",
    baseUrl: server.baseUrl || "",
    apiUrl: server.apiUrl || "",
    tokenAuth: server.tokenAuth || "bearer",
    oauthClientId: server.oauth?.clientId || "",
    oauthClientSecret: "",
    oauthScopes: server.oauth?.scopes || emptyGitServerForm.oauthScopes,
    webhookSecret: "",
    agentrixGitServerId: server.agentrixGitServerId || "",
    adminPat: "",
    commitAuthorName: server.commitAuthor?.name || emptyGitServerForm.commitAuthorName,
    commitAuthorEmail: server.commitAuthor?.email || defaultCommitAuthorEmail(server.baseUrl),
  }
}

function payloadFromForm(form: GitServerForm): GitServer {
  const payload: GitServer = {
    id: form.id.trim(),
    type: form.type,
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    apiUrl: form.apiUrl.trim(),
    tokenAuth: form.tokenAuth,
    oauth: {
      clientId: form.oauthClientId.trim(),
      scopes: form.oauthScopes.trim(),
    },
    webhook: {},
    agentrixGitServerId: form.agentrixGitServerId.trim(),
    commitAuthor: {
      name: form.commitAuthorName.trim(),
      email: form.commitAuthorEmail.trim(),
    },
  }
  if (form.oauthClientSecret) payload.oauth = { ...payload.oauth, clientSecret: form.oauthClientSecret }
  if (form.webhookSecret) payload.webhook = { secret: form.webhookSecret }
  if (form.adminPat) payload.adminPat = form.adminPat
  return payload
}

function defaultApiUrl(baseUrl = "") {
  const root = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
  return root ? `${root}/api/v4` : ""
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

function fingerprintLabel(value = "") {
  return value ? ` · ${value}` : ""
}

function userDisplayName(user: UserSession["user"]) {
  if (!user) return "User"
  if ("username" in user) return user.name || user.username || "User"
  return user.displayName || user.email || "User"
}

function userEmail(user: UserSession["user"]) {
  return user && "email" in user ? user.email || "" : ""
}

function connectedCount(accounts: Map<string, UserGitAccount | undefined>, gitServers: GitServer[]) {
  return gitServers.filter((server) => accounts.has(server.id)).length
}

function agentrixContextGitServerId(userSession: UserSession, gitServers: GitServer[]) {
  const gitlabServerIds = new Set(gitServers.filter((server) => server.type === "gitlab").map((server) => server.id))
  return (userSession.accounts || []).map((item) => item.account?.gitServerId || item.gitServer?.id || item.session?.gitServerId || "").find((id) => gitlabServerIds.has(id)) || ""
}

function providerIcon(type: string) {
  if (type === "github") return <GitBranch className="size-4 rotate-270" />
  return <GitBranch className="size-4" />
}

function accountTitle(account: UserGitAccount | undefined, server: GitServer) {
  return account?.displayName || account?.username || server.name || server.id
}

function serverLabel(server: GitServer, account?: UserGitAccount) {
  const identity = account?.username ? `@${account.username}` : server.type
  return `${server.name || server.id} · ${identity}`
}
