import { useMemo, useState } from "react"
import { Search } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import type { ProviderIssueLabel } from "@/issue-flow-model"

function labelColor(label: ProviderIssueLabel) {
  const color = label.color.replace(/^#/, "")
  return /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : "var(--muted-foreground)"
}

export function ProviderLabel({ label }: { label: ProviderIssueLabel }) {
  return <span className="provider-issue-label">{label.name}</span>
}

export function ProviderLabelPicker({ labels, selected, disabled = false, onChange }: { labels: ProviderIssueLabel[]; selected: string[]; disabled?: boolean; onChange: (labels: string[]) => void }) {
  const [query, setQuery] = useState("")
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? labels.filter((label) => `${label.name} ${label.description}`.toLowerCase().includes(needle)) : labels
  }, [labels, query])
  const selectedSet = useMemo(() => new Set(selected), [selected])

  function toggle(name: string, checked: boolean) {
    onChange(checked ? [...selectedSet, name] : selected.filter((label) => label !== name))
  }

  return <div className="provider-label-picker"><label><Search className="size-4" /><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Filter labels…" /></label><div>{filtered.length ? filtered.map((label) => <label key={label.name} className="provider-label-option"><Checkbox checked={selectedSet.has(label.name)} disabled={disabled} onCheckedChange={(checked) => toggle(label.name, checked === true)} /><i style={{ background: labelColor(label) }} /><span><span>{label.name}</span>{label.description ? <small>{label.description}</small> : null}</span></label>) : <p>No matching labels</p>}</div></div>
}
