export interface GitLabClientOptions {
  apiBaseUrl: string;
  token: string;
}

export type CommitActionType = "create" | "delete" | "move" | "update" | "chmod";

export interface CommitActionInput {
  action: CommitActionType;
  file_path?: string;
  previous_path?: string;
  content?: string;
  encoding?: "text" | "base64";
  execute_filemode?: boolean;
  last_commit_id?: string;
}

export interface CreateIssueInput {
  projectId: number;
  title: string;
  description: string;
  labels?: string[];
  assigneeId?: number;
}

export interface CreateMergeRequestInput {
  projectId: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  labels?: string[];
  assigneeId?: number;
  removeSourceBranch?: boolean;
}

export interface CreateCommitInput {
  projectId: number;
  branch: string;
  commitMessage: string;
  actions: CommitActionInput[];
  startBranch?: string;
}

export class GitLabClient {
  private readonly apiBaseUrl: string;
  private readonly token: string;

  constructor(options: GitLabClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.token = options.token;
  }

  async findUserIdByUsername(username: string): Promise<number | null> {
    const users = await this.request<Array<{ id: number; username: string }>>("/users", {
      method: "GET",
      query: {
        username,
        per_page: "20",
      },
    });

    if (users.length === 0) {
      return null;
    }

    const exact = users.find((user) => user.username === username);
    return exact?.id ?? users[0].id;
  }

  async createIssue(input: CreateIssueInput): Promise<any> {
    const body: Record<string, unknown> = {
      title: input.title,
      description: input.description,
    };

    if (input.labels && input.labels.length > 0) {
      body.labels = input.labels.join(",");
    }

    if (input.assigneeId) {
      body.assignee_ids = [input.assigneeId];
    }

    return this.request(`/projects/${encodeURIComponent(String(input.projectId))}/issues`, {
      method: "POST",
      body,
    });
  }

  async getIssue(projectId: number, issueIid: number): Promise<any> {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/issues/${encodeURIComponent(String(issueIid))}`,
      {
        method: "GET",
      },
    );
  }

  async getIssueNotes(projectId: number, issueIid: number): Promise<any> {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/issues/${encodeURIComponent(String(issueIid))}/notes`,
      {
        method: "GET",
      },
    );
  }

  async createIssueNote(projectId: number, issueIid: number, bodyText: string): Promise<any> {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/issues/${encodeURIComponent(String(issueIid))}/notes`,
      {
        method: "POST",
        body: {
          body: bodyText,
        },
      },
    );
  }

  async createBranch(projectId: number, branch: string, ref: string): Promise<any> {
    return this.request(`/projects/${encodeURIComponent(String(projectId))}/repository/branches`, {
      method: "POST",
      body: {
        branch,
        ref,
      },
    });
  }

  async getFile(projectId: number, filePath: string, ref = "HEAD"): Promise<any> {
    const encodedPath = encodeURIComponent(filePath);
    const response = await this.request<any>(
      `/projects/${encodeURIComponent(String(projectId))}/repository/files/${encodedPath}`,
      {
        method: "GET",
        query: {
          ref,
        },
      },
    );

    if (response && typeof response.content === "string") {
      return {
        ...response,
        decoded_content: Buffer.from(response.content, "base64").toString("utf-8"),
      };
    }

    return response;
  }

  async createCommit(input: CreateCommitInput): Promise<any> {
    const body: Record<string, unknown> = {
      branch: input.branch,
      commit_message: input.commitMessage,
      actions: input.actions,
    };

    if (input.startBranch) {
      body.start_branch = input.startBranch;
    }

    return this.request(`/projects/${encodeURIComponent(String(input.projectId))}/repository/commits`, {
      method: "POST",
      body,
    });
  }

  async createMergeRequest(input: CreateMergeRequestInput): Promise<any> {
    const body: Record<string, unknown> = {
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      title: input.title,
      description: input.description,
      remove_source_branch: Boolean(input.removeSourceBranch),
    };

    if (input.labels && input.labels.length > 0) {
      body.labels = input.labels.join(",");
    }

    if (input.assigneeId) {
      body.assignee_ids = [input.assigneeId];
    }

    return this.request(`/projects/${encodeURIComponent(String(input.projectId))}/merge_requests`, {
      method: "POST",
      body,
    });
  }

  async createMergeRequestNote(projectId: number, mrIid: number, bodyText: string): Promise<any> {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}/notes`,
      {
        method: "POST",
        body: {
          body: bodyText,
        },
      },
    );
  }

  async getMergeRequestChanges(projectId: number, mrIid: number): Promise<any> {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}/changes`,
      {
        method: "GET",
      },
    );
  }

  async approveMergeRequest(projectId: number, mrIid: number, sha?: string): Promise<any> {
    const body: Record<string, unknown> = {};
    if (sha) {
      body.sha = sha;
    }

    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}/approve`,
      {
        method: "POST",
        body,
      },
    );
  }

  async unapproveMergeRequest(projectId: number, mrIid: number): Promise<any> {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}/unapprove`,
      {
        method: "POST",
      },
    );
  }

  private async request<T>(
    path: string,
    options: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      query?: Record<string, string>;
      body?: Record<string, unknown>;
    },
  ): Promise<T> {
    const url = new URL(`${this.apiBaseUrl}${path}`);

    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": this.token,
    };

    const init: RequestInit = {
      method: options.method,
      headers,
    };

    if (options.body && options.method !== "GET") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, init);
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `GitLab API ${options.method} ${path} failed (${response.status} ${response.statusText}): ${responseText}`,
      );
    }

    if (!responseText) {
      return {} as T;
    }

    return JSON.parse(responseText) as T;
  }
}
