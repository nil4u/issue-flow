export type ArtifactType = "decision" | "plan"

export type SourceRef = {
  type: "readme" | "decision" | "plan" | "artifact" | "file"
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
  url: string
  modifiedAt: string
  status: string
  format?: "html" | "markdown"
  mergeRequestNumber?: number
  mergeRequestUrl?: string
  mergeRequestState?: string
}

export type LoadedIssue = {
  issueId: string
  issuePath: string
  title: string
  artifacts: IssueArtifact[]
}

export type VisionRouteContext = {
  gitServerId: string
  projectId: string
  issueNumber: number
  artifactType: ArtifactType
}

export type LoadedVisualArtifact = {
  issue: LoadedIssue
  html: string
  format: "html" | "markdown"
  drafts: DraftReviewItem[]
  reviews: VisualReview[]
}
