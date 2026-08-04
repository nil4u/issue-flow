export type ArtifactType = "decision" | "plan" | "optimization" | "markdown"

export type SourceRef = {
  type: "readme" | "decision" | "plan" | "optimization" | "artifact" | "file"
  path: string
  label?: string
}

export type VisualTargetElement = {
  selector?: string
  tagName?: string
  id?: string
  className?: string
  role?: string
  ariaLabel?: string
  dataRef?: string
  html?: string
  coverage?: "full" | "mostly" | "partial" | "touches"
  coveredArea?: string
  elementCoverageRatio?: number
  selectionCoverageRatio?: number
}

export type VisualTarget = {
  artifact: ArtifactType
  path: string
  kind: "point" | "rect"
  x: number
  y: number
  width?: number
  height?: number
  xRatio: number
  yRatio: number
  widthRatio?: number
  heightRatio?: number
  viewportWidth: number
  viewportHeight: number
  documentWidth: number
  documentHeight: number
  anchorRef?: string
  anchorSelector?: string
  anchorOffsetX?: number
  anchorOffsetY?: number
  element?: VisualTargetElement
  elements?: VisualTargetElement[]
  selectionText?: string
  data?: { ref: string; json: string }
}

export type DecisionReview = {
  action: "approve" | "discuss" | "select"
  ref: string
  id?: string
  question?: string
  optionId?: string
  optionLabel?: string
}

export type FeedbackRequest = {
  targetType: "issue" | "artifact"
  targetId: string
  intent: "defect" | "question" | "refinement"
  severity: "note" | "minor" | "major"
  comment: string
  sourceRefs: SourceRef[]
  visualTarget?: VisualTarget
  decision?: DecisionReview
}

export type DraftReviewItem = FeedbackRequest & {
  id: string
  artifactId?: string
  userId?: string
  createdAt: string
  updatedAt?: string
}

export type VisualReview = {
  id: string
  state: "draft" | "submitted"
  status: string
  kind: string
  payload: { items?: DraftReviewItem[] }
  submittedAt?: string
  createdAt: string
  updatedAt?: string
  user?: { name?: string; username?: string }
}

export type IssueArtifact = {
  type: ArtifactType
  path: string
  title: string
  modifiedAt: string
  status: string
  format?: "json" | "markdown"
  previewer?: string
  workflow?: "plan" | "preview"
  mergeRequestNumber?: number
  mergeRequestUrl?: string
  mergeRequestState?: string
}

export type LoadedIssue = {
  issueId: string
  issuePath: string
  title: string
  artifacts: IssueArtifact[]
  mergeRequests: Array<{
    number: number
    title: string
    state: string
    labels: string[]
  }>
}

export type VisionRouteContext = {
  gitServerId: string
  projectId: string
  issueNumber: number
  mergeRequestNumber?: number
  artifactPath?: string
}

export type VisionArtifactContext = VisionRouteContext & {
  artifactType: ArtifactType
}

export type LoadedVisualArtifact = {
  issue: LoadedIssue
  selectedPath: string
  html: string
  format: "json" | "markdown"
  drafts: DraftReviewItem[]
  reviews: VisualReview[]
  optimization?: {
    sourceIssueNumber: number
    proposals: OptimizationProposalState[]
  }
}

export type OptimizationProposalState = {
  id: string
  state: "pending" | "ignored" | "created" | "executing" | "completed" | "cancelled"
  childIssue: { number: number; title: string; state: string; webUrl: string } | null
  kind?: "project-change" | "project-developer-feedback" | "issue-flow-feedback"
  feedback?: { title: string; body: string; labels: string[]; text: string; url: string }
}
