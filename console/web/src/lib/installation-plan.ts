import type { InstallCheckProgress } from "@/issue-flow-model"

export type InstallationPlan = {
  provider: string
  steps: { id: string; label: string; configurable: boolean }[]
}

export function installProgressSteps(plan: InstallationPlan): InstallCheckProgress["steps"] {
  return plan.steps.map(({ id, label }) => ({ id, label, status: "pending" }))
}
