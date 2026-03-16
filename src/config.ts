export interface WorkflowDefaults {
  issueProjectId: number;
  issueProjectPath: string;
  codeProjectId: number;
  codeProjectPath: string;
  baseBranch: string;
  targetBranch: string;
  label: string;
  assigneeUsername: string;
  issueLogPath: string;
}

export interface RuntimeConfig {
  gitlabApiBaseUrl: string;
  gitlabToken: string;
  defaults: WorkflowDefaults;
}

const DEFAULTS: WorkflowDefaults = {
  issueProjectId: 2323,
  issueProjectPath: "chenba/test118",
  codeProjectId: 2323,
  codeProjectPath: "chenba/test118",
  baseBranch: "develop",
  targetBranch: "develop",
  label: "前端",
  assigneeUsername: "chenba",
  issueLogPath: "issue/log.md",
};

export function getRuntimeConfig(): RuntimeConfig {
  const gitlabToken = process.env.GITLAB_TOKEN?.trim() ?? "";

  if (!gitlabToken) {
    throw new Error("Missing GITLAB_TOKEN environment variable.");
  }

  const gitlabApiBaseUrl =
    process.env.GITLAB_API_BASE_URL?.trim() || "https://git.gobies.org/api/v4";

  return {
    gitlabApiBaseUrl,
    gitlabToken,
    defaults: {
      ...DEFAULTS,
      issueProjectId: parseIntEnv("WORKFLOW_ISSUE_PROJECT_ID", DEFAULTS.issueProjectId),
      issueProjectPath: process.env.WORKFLOW_ISSUE_PROJECT_PATH || DEFAULTS.issueProjectPath,
      codeProjectId: parseIntEnv("WORKFLOW_CODE_PROJECT_ID", DEFAULTS.codeProjectId),
      codeProjectPath: process.env.WORKFLOW_CODE_PROJECT_PATH || DEFAULTS.codeProjectPath,
      baseBranch: process.env.WORKFLOW_BASE_BRANCH || DEFAULTS.baseBranch,
      targetBranch: process.env.WORKFLOW_TARGET_BRANCH || DEFAULTS.targetBranch,
      label: process.env.WORKFLOW_LABEL || DEFAULTS.label,
      assigneeUsername: process.env.WORKFLOW_ASSIGNEE_USERNAME || DEFAULTS.assigneeUsername,
      issueLogPath: process.env.WORKFLOW_ISSUE_LOG_PATH || DEFAULTS.issueLogPath,
    },
  };
}

function parseIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return parsed;
}
