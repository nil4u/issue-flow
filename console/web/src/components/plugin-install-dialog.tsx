import { GitCommitHorizontal, Loader2, Wrench } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"

export function PluginInstallDialog({
  actionLabel,
  message,
  onMessageChange,
  onConfirm,
  onOpenChange,
  open,
  saving,
}: {
  actionLabel: string
  message: string
  onMessageChange: (value: string) => void
  onConfirm: () => Promise<void>
  onOpenChange: (open: boolean) => void
  open: boolean
  saving: boolean
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!saving) onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="plugin-install-dialog">
        <DialogHeader>
          <DialogTitle>{actionLabel} issue-flow</DialogTitle>
        </DialogHeader>
        <div className="plugin-install-dialog-body">
          <label htmlFor="issue-flow-commit-message">
            <span>Commit 描述（选填）</span>
            <Textarea
              autoFocus
              aria-describedby="issue-flow-commit-message-help"
              id="issue-flow-commit-message"
              placeholder="例如 chore: upgrade issue-flow plugin"
              value={message}
              onChange={(event) => onMessageChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !saving)
                  void onConfirm()
              }}
            />
          </label>
          <p id="issue-flow-commit-message-help">
            留空时使用默认 commit message；可按 Ctrl/⌘ + Enter 提交。
          </p>
        </div>
        <div className="plugin-install-dialog-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : actionLabel === "升级" ? (
              <GitCommitHorizontal className="size-4" />
            ) : (
              <Wrench className="size-4" />
            )}
            {actionLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
