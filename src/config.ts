export interface WorkflowEnvDefaults {
  issueProjectId?: number;
  issueProjectPath?: string;
  codeProjectId?: number;
  codeProjectPath?: string;
  baseBranch?: string;
  targetBranch?: string;
  label?: string;
  assigneeUsername?: string;
  issueLogPath?: string;
}

export interface WorkflowLocks {
  issueProjectId?: number;
  codeProjectId?: number;
}

export interface RuntimeConfig {
  gitlabApiBaseUrl: string;
  gitlabToken: string;
  defaults: WorkflowEnvDefaults;
  locks: WorkflowLocks;
}

export function getRuntimeConfig(): RuntimeConfig {
  const gitlabToken = process.env.GITLAB_TOKEN?.trim() ?? "";
  if (!gitlabToken) {
    throw new Error("Missing required env: GITLAB_TOKEN");
  }

  const gitlabApiBaseUrl = process.env.GITLAB_API_BASE_URL?.trim() ?? "";
  if (!gitlabApiBaseUrl) {
    throw new Error("Missing required env: GITLAB_API_BASE_URL");
  }

  return {
    gitlabApiBaseUrl,
    gitlabToken,
    defaults: {
      issueProjectId: parseOptionalInt(process.env.WORKFLOW_ISSUE_PROJECT_ID, "WORKFLOW_ISSUE_PROJECT_ID"),
      issueProjectPath: optionalString(process.env.WORKFLOW_ISSUE_PROJECT_PATH),
      codeProjectId: parseOptionalInt(process.env.WORKFLOW_CODE_PROJECT_ID, "WORKFLOW_CODE_PROJECT_ID"),
      codeProjectPath: optionalString(process.env.WORKFLOW_CODE_PROJECT_PATH),
      baseBranch: optionalString(process.env.WORKFLOW_BASE_BRANCH),
      targetBranch: optionalString(process.env.WORKFLOW_TARGET_BRANCH),
      label: optionalString(process.env.WORKFLOW_LABEL),
      assigneeUsername: optionalString(process.env.WORKFLOW_ASSIGNEE_USERNAME),
      issueLogPath: optionalString(process.env.WORKFLOW_ISSUE_LOG_PATH),
    },
    locks: {
      issueProjectId: parseOptionalInt(
        process.env.WORKFLOW_LOCK_ISSUE_PROJECT_ID,
        "WORKFLOW_LOCK_ISSUE_PROJECT_ID",
      ),
      codeProjectId: parseOptionalInt(
        process.env.WORKFLOW_LOCK_CODE_PROJECT_ID,
        "WORKFLOW_LOCK_CODE_PROJECT_ID",
      ),
    },
  };
}

function parseOptionalInt(raw: string | undefined, envName: string): number | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid env ${envName}: must be a positive integer`);
  }
  return parsed;
}

function optionalString(raw: string | undefined): string | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  return raw.trim();
}
