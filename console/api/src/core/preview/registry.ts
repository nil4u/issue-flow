// @ts-nocheck
import path from "node:path"

const PREVIEWERS = [
  { id: "decision-json", kind: "decision", format: "json", matches: (file) => file.basename === "decision-data.json" },
  { id: "plan-json", kind: "plan", format: "json", matches: (file) => file.basename === "plan-data.json" },
  { id: "issue-flow-visual", kind: "visual", format: "json", matches: (file) => file.extension === ".isv" },
  { id: "optimization-json", kind: "optimization", format: "json", matches: (file) => file.basename === "optimization-data.json" },
  { id: "markdown", kind: "markdown", format: "markdown", matches: (file) => file.extension === ".md" },
]

function normalizePreviewPath(value) {
  const normalized = path.posix.normalize(String(value || "").replace(/\\/g, "/").replace(/^\/+/, ""))
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined
  return normalized
}

function previewDescriptorForPath(value) {
  const filePath = normalizePreviewPath(value)
  if (!filePath) return undefined
  const basename = path.posix.basename(filePath).toLowerCase()
  const file = { path: filePath, basename, extension: path.posix.extname(basename) }
  const previewer = PREVIEWERS.find((candidate) => candidate.matches(file))
  return previewer ? { previewer: previewer.id, kind: previewer.kind, format: previewer.format, entryPath: filePath } : undefined
}

function previewableChangedFiles(files = []) {
  return (Array.isArray(files) ? files : [])
    .filter((file) => file && file.status !== "removed")
    .map((file) => previewDescriptorForPath(file.path))
    .filter(Boolean)
}

export { PREVIEWERS, normalizePreviewPath, previewDescriptorForPath, previewableChangedFiles }
