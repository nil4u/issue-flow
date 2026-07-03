import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { agentrixHelpTopics, type AgentrixHelpTopicId } from "@/lib/agentrix-help"

export function AgentrixHelpDialog({
  onOpenChange,
  topicId,
}: {
  onOpenChange: (open: boolean) => void
  topicId?: AgentrixHelpTopicId
}) {
  const topic = topicId ? agentrixHelpTopics[topicId] : undefined
  return (
    <Dialog open={Boolean(topic)} onOpenChange={onOpenChange}>
      <DialogContent className="agentrix-help-dialog">
        <DialogHeader>
          <DialogTitle>{topic?.title || "如何获取"}</DialogTitle>
        </DialogHeader>
        {topic && (
          <div className="agentrix-help-body">
            <p>{topic.summary}</p>
            <ol>
              {topic.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
            <div className="agentrix-help-gallery">
              {topic.images.map((image) => (
                <figure key={image.src}>
                  <img src={image.src} alt={image.alt} loading="lazy" />
                  <figcaption>{image.caption}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
