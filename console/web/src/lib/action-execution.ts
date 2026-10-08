import type {
  ActionExecutionSnapshot,
  ActionExecutionValues,
} from "@/issue-flow-model"

export function actionExecutionEditable(
  snapshot: ActionExecutionSnapshot | undefined,
  canManage: boolean,
  busy: boolean,
  error: string
) {
  return (
    canManage &&
    !busy &&
    !error &&
    snapshot?.state === "ready" &&
    !snapshot.pendingMergeRequest
  )
}

export function normalizedActionValues(
  actions: Record<string, ActionExecutionValues>
) {
  return Object.fromEntries(
    Object.entries(actions).map(([action, values]) => [
      action,
      Object.fromEntries(
        Object.entries(values)
          .filter(([, value]) => value?.trim())
          .map(([field, value]) => [field, value!.trim()])
      ),
    ])
  ) as Record<string, ActionExecutionValues>
}

export function actionValuesChanged(
  current: Record<string, ActionExecutionValues>,
  original: Record<string, ActionExecutionValues>
) {
  const normalized = normalizedActionValues(current)
  const baseline = normalizedActionValues(original)
  return Object.keys(baseline).some((action) =>
    ["agent", "model", "reasoningEffort"].some(
      (field) =>
        normalized[action]?.[field as keyof ActionExecutionValues] !==
        baseline[action]?.[field as keyof ActionExecutionValues]
    )
  )
}

export function actionFieldPlaceholder(
  action: string,
  field: keyof ActionExecutionValues,
  draft: Record<string, ActionExecutionValues>
) {
  const value = draft.defaults?.[field]?.trim()
  return action !== "defaults" && value
    ? `继承 · ${value}`
    : action === "defaults"
      ? "运行时默认"
      : "继承默认"
}

export const actionExecutionMessages: Record<string, string> = {
  missing: "未找到配置文件，请先安装 Issue Flow。",
  invalid_json: "配置文件不是有效 JSON。",
  invalid_config: "配置内容无效，请检查字段类型。",
  action_execution_revision_conflict: "默认分支配置已变更，请刷新后重新编辑。",
  action_execution_pending_merge_request: "已有待合并配置 MR，请先合并或关闭。",
  gitlab_project_permission_required:
    "需要 Maintainer 或 Owner 权限才能提交配置。",
  action_execution_permission_denied:
    "无权访问或修改 GitLab 仓库配置，请检查仓库权限。",
  gitlab_login_required: "请先登录 GitLab。",
  action_execution_gitlab_failed: "读取或提交 GitLab 配置失败，请重试。",
  action_execution_commit_failed: "GitLab 配置提交失败，请刷新后重试。",
  action_execution_invalid_input: "执行配置不合法，请检查输入。",
  action_execution_submission_in_progress: "配置正在读取或提交，请稍后刷新。",
}
