export type InstallCheckItemType = "variable" | "webhook" | "permission" | "repo_file"

export type InstallCheckControl = {
  path: string
  type: "text" | "password" | "select" | "checkbox"
  placeholder?: string
  options?: string[]
}

export type InstallCheckDefaultValue = string | boolean

export type InstallCheckConfigItem = {
  id: string
  type: InstallCheckItemType
  name: string
  description: string
  defaultValue?: InstallCheckDefaultValue
  control?: InstallCheckControl
}

export type InstallCheckConfigGroup = {
  id: string
  title: string
  items: InstallCheckConfigItem[]
}

export const gitlabInstallCheckConfig = {
  provider: "gitlab",
  groups: [
    {
      id: "variables",
      title: "Variables",
      items: [
        {
          id: "variable:AGENTRIX_BASE_URL",
          type: "variable",
          name: "AGENTRIX_BASE_URL",
          description: "Agentrix 服务地址，GitLab CI 使用它调用 Agentrix API。",
          defaultValue: "https://agentrix.xmz.ai",
        },
        {
          id: "variable:AGENTRIX_API_KEY",
          type: "variable",
          name: "AGENTRIX_API_KEY",
          description: "GitLab CI 调用 Agentrix API 的密钥。",
          control: {
            path: "agentrix.apiKey",
            type: "password",
            placeholder: "填写 Agentrix API key",
          },
        },
        {
          id: "variable:AGENTRIX_RUNNER_ID",
          type: "variable",
          name: "AGENTRIX_RUNNER_ID",
          description: "指定 Agentrix 的 Machine ID 或 Cloud ID。",
          control: {
            path: "agentrix.runnerId",
            type: "text",
            placeholder: "填写 Machine ID 或 Cloud ID",
          },
        },
        {
          id: "variable:AGENTRIX_ISSUE_FLOW_AGENT",
          type: "variable",
          name: "AGENTRIX_ISSUE_FLOW_AGENT",
          description: "Issue Flow 使用的 Agent 名称。",
          defaultValue: "codex",
          control: {
            path: "automation.agent",
            type: "text",
          },
        },
        {
          id: "variable:ISSUE_FLOW_AUTO_DEFAULT",
          type: "variable",
          name: "ISSUE_FLOW_AUTO_DEFAULT",
          description: "Issue Flow 的默认自动处理策略。",
          defaultValue: "triage",
          control: {
            path: "automation.autoDefault",
            type: "select",
            options: ["off", "triage", "plan", "build"],
          },
        },
        {
          id: "variable:ISSUE_FLOW_REVIEW_ENABLED",
          type: "variable",
          name: "ISSUE_FLOW_REVIEW_ENABLED",
          description: "是否启用 PR review 自动处理。",
          defaultValue: false,
          control: {
            path: "automation.reviewEnabled",
            type: "checkbox",
          },
        },
      ],
    },
    {
      id: "webhook",
      title: "Webhook",
      items: [
        {
          id: "webhook",
          type: "webhook",
          name: "GitLab webhook",
          description: "接收 issue、comment、MR 和 pipeline 事件的 GitLab webhook。",
        },
      ],
    },
  ],
} satisfies {
  provider: "gitlab"
  groups: InstallCheckConfigGroup[]
}
