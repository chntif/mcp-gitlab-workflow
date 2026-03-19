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
  localRepoPath?: string;
  localGitRemoteName?: string;
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

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  gitlabApiBaseUrl: "https://gitlab.com/api/v4",
  gitlabToken: "",
  defaults: {
    issueProjectId: undefined,
    issueProjectPath: undefined,
    codeProjectId: undefined,
    codeProjectPath: undefined,
    baseBranch: "develop",
    targetBranch: "develop",
    label: undefined,
    assigneeUsername: undefined,
    issueLogPath: "issue-log.md",
    localRepoPath: undefined,
    localGitRemoteName: "origin",
  },
  locks: {
    issueProjectId: undefined,
    codeProjectId: undefined,
  },
};

export function getRuntimeConfig(): RuntimeConfig {
  const gitlabToken = stringEnv("GITLAB_TOKEN", DEFAULT_RUNTIME_CONFIG.gitlabToken) ?? "";
  if (!gitlabToken) {
    throw new Error("Missing required env: GITLAB_TOKEN");
  }

  const gitlabApiBaseUrl =
    stringEnv("GITLAB_API_BASE_URL", DEFAULT_RUNTIME_CONFIG.gitlabApiBaseUrl) ?? "";

  return {
    gitlabApiBaseUrl,
    gitlabToken,
    defaults: {
      issueProjectId: intEnv(
        "WORKFLOW_ISSUE_PROJECT_ID",
        "WORKFLOW_ISSUE_PROJECT_ID",
        DEFAULT_RUNTIME_CONFIG.defaults.issueProjectId,
      ),
      issueProjectPath: stringEnv(
        "WORKFLOW_ISSUE_PROJECT_PATH",
        DEFAULT_RUNTIME_CONFIG.defaults.issueProjectPath,
      ),
      codeProjectId: intEnv(
        "WORKFLOW_CODE_PROJECT_ID",
        "WORKFLOW_CODE_PROJECT_ID",
        DEFAULT_RUNTIME_CONFIG.defaults.codeProjectId,
      ),
      codeProjectPath: stringEnv(
        "WORKFLOW_CODE_PROJECT_PATH",
        DEFAULT_RUNTIME_CONFIG.defaults.codeProjectPath,
      ),
      baseBranch: stringEnv("WORKFLOW_BASE_BRANCH", DEFAULT_RUNTIME_CONFIG.defaults.baseBranch),
      targetBranch: stringEnv("WORKFLOW_TARGET_BRANCH", DEFAULT_RUNTIME_CONFIG.defaults.targetBranch),
      label: stringEnv("WORKFLOW_LABEL", DEFAULT_RUNTIME_CONFIG.defaults.label),
      assigneeUsername: stringEnv(
        "WORKFLOW_ASSIGNEE_USERNAME",
        DEFAULT_RUNTIME_CONFIG.defaults.assigneeUsername,
      ),
      issueLogPath: stringEnv("WORKFLOW_ISSUE_LOG_PATH", DEFAULT_RUNTIME_CONFIG.defaults.issueLogPath),
      localRepoPath: stringEnv("WORKFLOW_LOCAL_REPO_PATH", DEFAULT_RUNTIME_CONFIG.defaults.localRepoPath),
      localGitRemoteName: stringEnv(
        "WORKFLOW_LOCAL_REMOTE_NAME",
        DEFAULT_RUNTIME_CONFIG.defaults.localGitRemoteName,
      ),
    },
    locks: {
      issueProjectId: intEnv(
        "WORKFLOW_LOCK_ISSUE_PROJECT_ID",
        "WORKFLOW_LOCK_ISSUE_PROJECT_ID",
        DEFAULT_RUNTIME_CONFIG.locks.issueProjectId,
      ),
      codeProjectId: intEnv(
        "WORKFLOW_LOCK_CODE_PROJECT_ID",
        "WORKFLOW_LOCK_CODE_PROJECT_ID",
        DEFAULT_RUNTIME_CONFIG.locks.codeProjectId,
      ),
    },
  };
}

function intEnv(envName: string, errorLabel: string, fallback?: number): number | undefined {
  return parseOptionalInt(process.env[envName], errorLabel, fallback);
}

function stringEnv(envName: string, fallback?: string): string | undefined {
  return optionalString(process.env[envName]) ?? fallback;
}

function parseOptionalInt(raw: string | undefined, envName: string, fallback?: number): number | undefined {
  if (!raw?.trim()) {
    return fallback;
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
