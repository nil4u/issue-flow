import type { GitRunnerSetting } from "@/issue-flow-model"

function runnerLabel(runner: GitRunnerSetting) {
  const id = runner.runnerId ? `#${runner.runnerId}` : runner.name || "runner"
  return runner.shortToken ? `${id} (${runner.shortToken})` : id
}

export function GitRunnerValue({ href, runner }: { href?: string; runner: GitRunnerSetting }) {
  const label = runnerLabel(runner)
  const tags = runner.tagList || []
  const description = runner.description || ""
  const content = (
    <>
      <span className="runner-value-head">
        <span className="runner-value-dot" />
        <strong>{label}</strong>
      </span>
      {description && <small>{description}</small>}
      {tags.length > 0 && (
        <span className="runner-value-tags">
          {tags.map((tag) => <span key={tag}>{tag}</span>)}
        </span>
      )}
    </>
  )

  if (href) {
    return <a className="runner-value" href={href} target="_blank" rel="noreferrer">{content}</a>
  }
  return <span className="runner-value">{content}</span>
}
