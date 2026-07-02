import type { EmptyPanelProps } from "@/issue-flow-model"

export function EmptyPanel({ icon, title, detail, children }: EmptyPanelProps) {
  return (
    <div className="empty-panel">
      {icon}
      <strong>{title}</strong>
      <span>{detail}</span>
      {children}
    </div>
  )
}
