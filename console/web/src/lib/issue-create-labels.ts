export const VISUAL_PLAN_LABEL = "feature:visual-plan:on"

export function defaultNewIssueLabels(visualPlanEnabled = false) {
  return visualPlanEnabled ? [VISUAL_PLAN_LABEL] : []
}

export function showDefaultVisionPlanNotice(visualPlanEnabled: boolean, selectedLabels: string[]) {
  return visualPlanEnabled && selectedLabels.includes(VISUAL_PLAN_LABEL)
}
