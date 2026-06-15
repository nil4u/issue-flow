export type GitLabIssue = {
  iid: number;
  title: string;
  state: string;
  created_at: string;
  closed_at?: string | null;
  labels: string[];
  author?: { username?: string };
  assignee?: { username?: string } | null;
};

export type GitLabLabelEvent = {
  action: 'add' | 'remove';
  created_at: string;
  label?: { name?: string };
};

export type GitLabStateEvent = {
  state: string;
  created_at: string;
};

export class GitLabClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      token: string;
      projectId?: string;
      projectPath: string;
    }
  ) {}

  private projectId() {
    const projectId = this.options.projectId?.trim();
    const apiIdentifier = projectId && /^\d+$/.test(projectId) ? projectId : this.options.projectPath;
    return encodeURIComponent(apiIdentifier);
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/api/v4${path}`, {
      headers: {
        'PRIVATE-TOKEN': this.options.token
      }
    });
    if (!response.ok) {
      throw new Error(`GitLab request failed ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  async listIssues() {
    return this.getJson<GitLabIssue[]>(`/projects/${this.projectId()}/issues?per_page=100&state=all`);
  }

  async listLabelEvents(iid: number) {
    return this.getJson<GitLabLabelEvent[]>(`/projects/${this.projectId()}/issues/${iid}/resource_label_events?per_page=100`);
  }

  async listStateEvents(iid: number) {
    return this.getJson<GitLabStateEvent[]>(`/projects/${this.projectId()}/issues/${iid}/resource_state_events?per_page=100`);
  }
}
