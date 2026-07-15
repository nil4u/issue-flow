// Review anchor support for data-compiled artifacts.
//
// New-style artifacts (produced by the agentrix-visual-artifact skill) embed their
// logical plan facts as a JSON data island (<script type="application/json"
// id="plan-data">) and tag every review object with data-ref="<path into that
// JSON>" plus qualifier anchors (data-state, data-path, ...). This module holds the
// pure logic for scoring, selector generation, and data-ref resolution so it can be
// unit-tested without a DOM. Old artifacts without these attributes must keep the
// exact pre-existing behavior; callers gate on that.

export const PLAN_DATA_ISLAND_ID = "plan-data";

// Order matters: selector generation emits attributes in this order, data-ref first.
export const REVIEW_ANCHOR_ATTRIBUTES = [
  "data-ref",
  "data-review-scope",
  "data-entity",
  "data-state",
  "data-stage",
  "data-step",
  "data-transition",
  "data-path",
  "data-invariant",
  "data-boundary",
  "data-risk"
] as const;

// Minimal structural view of a DOM element so tests can use plain objects.
export type AnchorElementLike = {
  tagName: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  parentElement: AnchorElementLike | null;
};

export function anchorBonus(element: Pick<AnchorElementLike, "hasAttribute">): number {
  if (element.hasAttribute("data-ref")) return 70;
  if (REVIEW_ANCHOR_ATTRIBUTES.some((attribute) => element.hasAttribute(attribute))) return 60;
  return 0;
}

// Nearest data-ref on the element or its ancestors. Review objects carry their own
// ref; text fragments inside them inherit the enclosing object's ref.
export function findDataRef(element: AnchorElementLike | null): string | undefined {
  for (let node = element; node; node = node.parentElement) {
    const value = node.getAttribute("data-ref")?.trim();
    if (value) return value;
  }
  return undefined;
}

function escapeAttributeValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

// Selector built from the element's own anchor attributes, e.g.
// article[data-ref="transitions.t3"] or li[data-entity="workspace"][data-state="offline"].
// Returns undefined when the element carries no anchor attributes.
export function anchorSelector(element: AnchorElementLike): string | undefined {
  const parts: string[] = [];
  for (const attribute of REVIEW_ANCHOR_ATTRIBUTES) {
    const value = element.getAttribute(attribute)?.trim();
    if (!value) continue;
    parts.push(`[${attribute}="${escapeAttributeValue(value)}"]`);
    if (parts.length === 3) break;
  }
  if (!parts.length) return undefined;
  return `${element.tagName.toLowerCase()}${parts.join("")}`;
}

export function parsePlanDataIsland(text: string | null | undefined): unknown {
  if (!text?.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Resolves a data-ref path against parsed plan data. Path grammar: dot-separated
// segments; each segment is an object key, an array index, or — for arrays of
// objects — a match on the entry's `id` field, so "transitions.t3" finds
// { transitions: [{ id: "t3", ... }] } as well as { transitions: { t3: ... } }.
export function resolvePlanDataRef(data: unknown, ref: string): unknown {
  const segments = ref.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) return undefined;
  let current: unknown = data;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = /^\d+$/.test(segment) ? Number(segment) : -1;
      current = index >= 0
        ? current[index]
        : current.find((entry) => typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === segment);
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

// Pretty-printed JSON snippet bounded for review files; must stay within the
// VisualTarget schema's data.json max length.
export const PLAN_DATA_SNIPPET_MAX_LENGTH = 6000;

export function formatPlanDataSnippet(value: unknown, maxLength = PLAN_DATA_SNIPPET_MAX_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
  if (typeof json !== "string") return undefined;
  return json.length > maxLength ? `${json.slice(0, maxLength - 1)}…` : json;
}
