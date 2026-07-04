export type AgentrixHelpTopicId = "agentrix-api-key" | "agentrix-runner-id"

export type AgentrixHelpTopic = {
  id: AgentrixHelpTopicId
  title: string
  summary: string
  steps: string[]
  images: Array<{
    src: string
    alt: string
    caption: string
  }>
}

export const agentrixHelpTopics: Record<AgentrixHelpTopicId, AgentrixHelpTopic> = {
  "agentrix-api-key": {
    id: "agentrix-api-key",
    title: "获取 Agentrix API Key",
    summary: "用于 GitLab CI 调用 Agentrix API。建议使用个人或团队专用 key，不要复用临时测试 key。",
    steps: [
      "1. 打开 Agentrix Desktop 或 Web 控制台，进入 Settings。",
      "2. 在 DEVELOPER 区域点击 API Keys。",
      "3. 在 API Keys 页面点击右上角 + 创建新 key。",
      "4. 复制新生成的 key，填入 AGENTRIX_API_KEY。",
    ],
    images: [
      {
        src: "/agentrix-help/agentrix-api-key-settings.png",
        alt: "Agentrix Settings 中 API Keys 入口",
        caption: "Settings 页面，进入 API Keys。",
      },
      {
        src: "/agentrix-help/agentrix-api-key-list.png",
        alt: "Agentrix API Keys 管理页面",
        caption: "API Keys 页面，点击 + 新建并复制 key。",
      },
    ],
  },
  "agentrix-runner-id": {
    id: "agentrix-runner-id",
    title: "获取 Agentrix Runner ID",
    summary: "用于指定 issue-flow jobs 投递到哪一个 Agentrix 执行环境，可填写 Cloud ID 或 Local Machine ID。",
    steps: [
      "1. 打开 Agentrix Settings，进入 Private Clouds。",
      "2. 选择已经绑定并在线的 cloud。",
      "3. 在 cloud 详情页确认机器在线。",
      "4. 点击 Copy Cloud ID，复制后填入 AGENTRIX_RUNNER_ID。",
    ],
    images: [
      {
        src: "/agentrix-help/agentrix-runner-cloud-list.png",
        alt: "Agentrix Private Clouds 列表",
        caption: "Private Clouds 页面，进入目标 cloud。",
      },
      {
        src: "/agentrix-help/agentrix-runner-copy-cloud-id.png",
        alt: "Agentrix Copy Cloud ID 入口",
        caption: "点击 Copy Cloud ID，作为 Runner ID 使用。",
      },
    ],
  },
}
