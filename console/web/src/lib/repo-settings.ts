import type { Repository } from "@/issue-flow-model"

export function hasRepoSettingsData(settings?: Repository["settings"]) {
  if (!settings) return false

  const collections = [
    settings.permissions,
    settings.variables,
    settings.plugins,
    settings.runners,
  ]
  return (
    collections.some((section) =>
      Boolean(section?.checkedAt || section?.items?.length)
    ) || Boolean(settings.webhook && Object.keys(settings.webhook).length)
  )
}
