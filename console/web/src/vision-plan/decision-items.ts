export type DecisionItemType = "approval" | "choice"

export type DecisionOption = {
  id: string
  label: string
  ref: string
  recommended: boolean
}

export type DecisionItem = {
  id: string
  question?: string
  ref: string
  type: DecisionItemType
  options: DecisionOption[]
  recommendedOptionId?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function decisionItemsFromData(data: unknown): DecisionItem[] {
  const decisions = record(data)?.decisions
  if (!Array.isArray(decisions)) return []
  return decisions.flatMap((value) => {
    const item = record(value)
    const id = text(item?.id)
    if (!item || !id) return []
    const ref = `decisions.${id}`
    const options = Array.isArray(item.options)
      ? item.options.flatMap((optionValue, index) => {
        const option = record(optionValue)
        const optionId = text(option?.id) ?? String(index)
        if (!option) return []
        return [{
          id: optionId,
          label: text(option.label) ?? text(option.title) ?? text(option.name) ?? optionId,
          ref: `${ref}.options.${optionId}`,
          recommended: option.recommended === true,
        }]
      })
      : []
    const declaredType = text(item.type)
    const type: DecisionItemType = declaredType === "approval" || !options.length ? "approval" : "choice"
    const recommendedOptionId = text(item.recommendedOptionId)
      ?? text(item.recommended)
      ?? options.find((option) => option.recommended)?.id
    return [{ id, question: text(item.question), ref, type, options, recommendedOptionId }]
  })
}

export function decisionItemsFromDocument(document: Document): DecisionItem[] {
  const island = document.getElementById("plan-data")
  if (!island?.textContent?.trim()) return []
  try {
    return decisionItemsFromData(JSON.parse(island.textContent))
  } catch {
    return []
  }
}

export function interactiveDecisionRefs(items: DecisionItem[]) {
  return new Set(items.flatMap((item) => [item.ref, ...item.options.map((option) => option.ref)]))
}
