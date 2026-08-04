type SearchableLabel = {
  name?: string
  description?: string
}

const MANAGED_ISSUE_LABEL_PREFIXES = ["type::", "status::", "flow::", "feature:visual-plan:", "automation::", "optimization::", "priority::", "size::", "mr-by::", "review::"]

const SEARCH_SEPARATOR = /[^\p{L}\p{N}]+/gu

function normalizeSearchValue(value: unknown) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().trim()
}

export function labelMatchesQuery(label: SearchableLabel, query: string) {
  const needle = normalizeSearchValue(query)
  if (!needle) return true

  const haystack = normalizeSearchValue(`${label.name || ""} ${label.description || ""}`)
  if (haystack.includes(needle)) return true

  const compactNeedle = needle.replace(SEARCH_SEPARATOR, "")
  const compactHaystack = haystack.replace(SEARCH_SEPARATOR, "")
  if (compactNeedle && compactHaystack.includes(compactNeedle)) return true

  const tokens = needle.split(SEARCH_SEPARATOR).filter(Boolean)
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token))
}

export function isManagedIssueLabel(name: string) {
  return MANAGED_ISSUE_LABEL_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export function isManagedMergeRequestLabel(name: string) {
  return name.startsWith("mr-by::") || name.startsWith("review::")
}
