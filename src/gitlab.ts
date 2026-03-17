export interface GitLabClientOptions {
  apiBaseUrl: string;
  token: string;
}

type QueryValue = string | number | boolean;

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
  description?: string;
  labels?: string[];
  assigneeIds?: number[];
  milestoneId?: number;
  dueDate?: string;
  confidential?: boolean;
  issueType?: string;
}

export interface CreateMergeRequestInput {
  projectId: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  labels?: string[];
  assigneeIds?: number[];
  reviewerIds?: number[];
  removeSourceBranch?: boolean;
  squash?: boolean;
  draft?: boolean;
}

export interface CreateCommitInput {
  projectId: number;
  branch: string;
  commitMessage: string;
  actions: CommitActionInput[];
  startBranch?: string;
}

export interface LabelListOptions {
  search?: string;
  page?: number;
  perPage?: number;
  withCounts?: boolean;
  includeAncestorGroups?: boolean;
}

export interface CreateLabelInput {
  projectId: number;
  name: string;
  color: string;
  description?: string;
  priority?: number;
}

export interface UpdateLabelInput {
  projectId: number;
  name: string;
  newName?: string;
  color?: string;
  description?: string;
  priority?: number;
}

export interface MergeRequestNotesOptions {
  sort?: "asc" | "desc";
  orderBy?: "created_at" | "updated_at";
}

export interface ListMergeRequestsOptions {
  state?: "opened" | "closed" | "locked" | "merged" | "all";
  sourceBranch?: string;
  targetBranch?: string;
  orderBy?: "created_at" | "title" | "updated_at";
  sort?: "asc" | "desc";
  page?: number;
  perPage?: number;
}

export interface UploadProjectFileInput {
  projectId: number;
  filename: string;
  contentBase64: string;
  contentType?: string;
}

export interface DownloadBinaryAsBase64Result {
  source_url: string;
  resolved_url: string;
  content_type?: string;
  size_bytes: number;
  base64: string;
}

export class GitLabClient {
  private readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly webBaseUrl: string;

  constructor(options: GitLabClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.webBaseUrl = this.apiBaseUrl.replace(/\/api\/v4\/?$/i, "");
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

  async getCurrentUser(): Promise<any> {
    return this.request("/user", {
      method: "GET",
    });
  }

  async listLabels(projectId: number, options?: LabelListOptions): Promise<any> {
    const query: Record<string, QueryValue> = {};
    if (options?.search) {
      query.search = options.search;
    }
    if (options?.page !== undefined) {
      query.page = options.page;
    }
    if (options?.perPage !== undefined) {
      query.per_page = options.perPage;
    }
    if (options?.withCounts !== undefined) {
      query.with_counts = options.withCounts;
    }
    if (options?.includeAncestorGroups !== undefined) {
      query.include_ancestor_groups = options.includeAncestorGroups;
    }

    return this.request(`/projects/${encodeURIComponent(String(projectId))}/labels`, {
      method: "GET",
      query,
    });
  }

  async createLabel(input: CreateLabelInput): Promise<any> {
    const body: Record<string, unknown> = {
      name: input.name,
      color: input.color,
    };
    if (input.description !== undefined) {
      body.description = input.description;
    }
    if (input.priority !== undefined) {
      body.priority = input.priority;
    }

    return this.request(`/projects/${encodeURIComponent(String(input.projectId))}/labels`, {
      method: "POST",
      body,
    });
  }

  async updateLabel(input: UpdateLabelInput): Promise<any> {
    const body: Record<string, unknown> = {
      name: input.name,
    };

    if (input.newName !== undefined) {
      body.new_name = input.newName;
    }
    if (input.color !== undefined) {
      body.color = input.color;
    }
    if (input.description !== undefined) {
      body.description = input.description;
    }
    if (input.priority !== undefined) {
      body.priority = input.priority;
    }

    return this.request(`/projects/${encodeURIComponent(String(input.projectId))}/labels`, {
      method: "PUT",
      body,
    });
  }

  async deleteLabel(projectId: number, labelName: string): Promise<any> {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/labels/${encodeURIComponent(labelName)}`,
      {
        method: "DELETE",
      },
    );
  }

  async createIssue(input: CreateIssueInput): Promise<any> {
    const body: Record<string, unknown> = {
      title: input.title,
    };

    if (input.description !== undefined) {
      body.description = input.description;
    }

    if (input.labels && input.labels.length > 0) {
      body.labels = input.labels.join(",");
    }

    if (input.assigneeIds && input.assigneeIds.length > 0) {
      body.assignee_ids = input.assigneeIds;
    }

    if (input.milestoneId !== undefined) {
      body.milestone_id = input.milestoneId;
    }

    if (input.dueDate !== undefined) {
      body.due_date = input.dueDate;
    }

    if (input.confidential !== undefined) {
      body.confidential = input.confidential;
    }

    if (input.issueType !== undefined) {
      body.issue_type = input.issueType;
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

  async getIssueNotes(
    projectId: number,
    issueIid: number,
    options?: {
      sort?: "asc" | "desc";
      orderBy?: "created_at" | "updated_at";
    },
  ): Promise<any> {
    const query: Record<string, string> = {};
    if (options?.sort) {
      query.sort = options.sort;
    }
    if (options?.orderBy) {
      query.order_by = options.orderBy;
    }

    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/issues/${encodeURIComponent(String(issueIid))}/notes`,
      {
        method: "GET",
        query,
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
    };

    if (input.description !== undefined) {
      body.description = input.description;
    }

    if (input.labels && input.labels.length > 0) {
      body.labels = input.labels.join(",");
    }

    if (input.assigneeIds && input.assigneeIds.length > 0) {
      body.assignee_ids = input.assigneeIds;
    }

    if (input.reviewerIds && input.reviewerIds.length > 0) {
      body.reviewer_ids = input.reviewerIds;
    }

    if (input.squash !== undefined) {
      body.squash = input.squash;
    }

    if (input.removeSourceBranch !== undefined) {
      body.remove_source_branch = input.removeSourceBranch;
    }

    if (input.draft !== undefined) {
      body.draft = input.draft;
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

  async getMergeRequest(projectId: number, mrIid: number): Promise<any> {
    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}`,
      {
        method: "GET",
      },
    );
  }

  async listMergeRequests(projectId: number, options?: ListMergeRequestsOptions): Promise<any> {
    const query: Record<string, QueryValue> = {};
    if (options?.state) {
      query.state = options.state;
    }
    if (options?.sourceBranch) {
      query.source_branch = options.sourceBranch;
    }
    if (options?.targetBranch) {
      query.target_branch = options.targetBranch;
    }
    if (options?.orderBy) {
      query.order_by = options.orderBy;
    }
    if (options?.sort) {
      query.sort = options.sort;
    }
    if (options?.page !== undefined) {
      query.page = options.page;
    }
    if (options?.perPage !== undefined) {
      query.per_page = options.perPage;
    }

    return this.request(`/projects/${encodeURIComponent(String(projectId))}/merge_requests`, {
      method: "GET",
      query,
    });
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

  async getMergeRequestNotes(
    projectId: number,
    mrIid: number,
    options?: MergeRequestNotesOptions,
  ): Promise<any> {
    const query: Record<string, QueryValue> = {};
    if (options?.sort) {
      query.sort = options.sort;
    }
    if (options?.orderBy) {
      query.order_by = options.orderBy;
    }

    return this.request(
      `/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}/notes`,
      {
        method: "GET",
        query,
      },
    );
  }

  async uploadProjectFile(input: UploadProjectFileInput): Promise<any> {
    const buffer = Buffer.from(input.contentBase64, "base64");
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([buffer], {
        type: input.contentType ?? "application/octet-stream",
      }),
      input.filename,
    );

    const response = await fetch(
      this.buildApiUrl(`/projects/${encodeURIComponent(String(input.projectId))}/uploads`),
      {
        method: "POST",
        headers: {
          "PRIVATE-TOKEN": this.token,
        },
        body: formData,
      },
    );
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `GitLab API POST /projects/:id/uploads failed (${response.status} ${response.statusText}): ${responseText}`,
      );
    }
    if (!responseText) {
      return {};
    }
    return JSON.parse(responseText) as any;
  }

  resolveWebUrl(urlOrPath: string): string {
    const trimmed = urlOrPath.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith("/")) {
      return `${this.webBaseUrl}${trimmed}`;
    }
    return `${this.webBaseUrl}/${trimmed}`;
  }

  async downloadBinaryAsBase64(urlOrPath: string): Promise<DownloadBinaryAsBase64Result> {
    const resolvedUrl = this.resolveWebUrl(urlOrPath);
    const response = await fetch(resolvedUrl, {
      method: "GET",
      headers: {
        "PRIVATE-TOKEN": this.token,
      },
    });
    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(
        `GitLab binary download failed (${response.status} ${response.statusText}) for ${resolvedUrl}: ${responseText}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return {
      source_url: urlOrPath,
      resolved_url: resolvedUrl,
      content_type: response.headers.get("content-type") ?? undefined,
      size_bytes: buffer.byteLength,
      base64: buffer.toString("base64"),
    };
  }

  private buildApiUrl(path: string, query?: Record<string, QueryValue | undefined>): URL {
    const url = new URL(`${this.apiBaseUrl}${path}`);
    if (!query) {
      return url;
    }
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async request<T>(
    path: string,
    options: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      query?: Record<string, QueryValue | undefined>;
      body?: Record<string, unknown>;
    },
  ): Promise<T> {
    const url = this.buildApiUrl(path, options.query);

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
