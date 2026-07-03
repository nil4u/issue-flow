import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"

export type VariableDialogRow = {
  title?: string
  variable?: {
    key?: string
  }
}

export function VariableSettingsDialog({
  onOpenChange,
  onSave,
  onValueChange,
  placeholder = "",
  row,
  saving,
  value,
}: {
  onOpenChange: (open: boolean) => void
  onSave: () => Promise<void>
  onValueChange: (value: string) => void
  placeholder?: string
  row?: VariableDialogRow
  saving: boolean
  value: string
}) {
  const title = row?.variable?.key || row?.title || "设置变量"
  return (
    <Dialog open={Boolean(row)} onOpenChange={onOpenChange}>
      <DialogContent className="variable-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="variable-dialog-body">
          <Textarea
            autoFocus
            aria-label={title}
            className="variable-dialog-input"
            id="variable-value"
            placeholder={placeholder}
            value={value}
            onChange={(event) => onValueChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                void onSave()
              }
            }}
          />
        </div>
        <div className="variable-dialog-actions">
          <Button type="button" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
