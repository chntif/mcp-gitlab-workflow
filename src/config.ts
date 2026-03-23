import { normalizeDeliveryMethod, type DeliveryMethod } from "./delivery-mode.js";

export interface WorkflowEnvDefaults {
  issueProjectId?: number;
  issueProjectPath?: string;
  codeProjectId?: number;
  codeProjectPath?: string;
  deliveryMethod?: DeliveryMethod;
  baseBranch?: string;
  targetBranch?: string;
  label?: string;
  assigneeUsername?: string;
  issueLogPath?: string;
  localGitRemoteName?: string;
  checkoutLocalBranch?: boolean;
  updateIssueLog?: boolean;
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
  gitlabApiBaseUrl: "",
  gitlabToken: "",
  defaults: {
    issueProjectId: undefined,
    issueProjectPath: undefined,
    codeProjectId: undefined,
    codeProjectPath: undefined,
    deliveryMethod: "local_git",
    baseBranch: "develop",
    targetBranch: "develop",
    label: undefined,
    assigneeUsername: undefined,
    issueLogPath: "issue-log.md",
    localGitRemoteName: "origin",
    checkoutLocalBranch: false,
    updateIssueLog: true,
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
      deliveryMethod: deliveryMethodEnv(
        "WORKFLOW_DELIVERY_METHOD",
        DEFAULT_RUNTIME_CONFIG.defaults.deliveryMethod,
      ),
      baseBranch: stringEnv("WORKFLOW_BASE_BRANCH", DEFAULT_RUNTIME_CONFIG.defaults.baseBranch),
      targetBranch: stringEnv("WORKFLOW_TARGET_BRANCH", DEFAULT_RUNTIME_CONFIG.defaults.targetBranch),
      label: stringEnv("WORKFLOW_LABEL", DEFAULT_RUNTIME_CONFIG.defaults.label),
      assigneeUsername: stringEnv(
        "WORKFLOW_ASSIGNEE_USERNAME",
        DEFAULT_RUNTIME_CONFIG.defaults.assigneeUsername,
      ),
      issueLogPath: stringEnv("WORKFLOW_ISSUE_LOG_PATH", DEFAULT_RUNTIME_CONFIG.defaults.issueLogPath),
      localGitRemoteName: stringEnv(
        "WORKFLOW_LOCAL_REMOTE_NAME",
        DEFAULT_RUNTIME_CONFIG.defaults.localGitRemoteName,
      ),
      checkoutLocalBranch: booleanEnv(
        "WORKFLOW_CHECKOUT_LOCAL_BRANCH",
        DEFAULT_RUNTIME_CONFIG.defaults.checkoutLocalBranch,
      ),
      updateIssueLog: booleanEnv(
        "WORKFLOW_UPDATE_ISSUE_LOG",
        DEFAULT_RUNTIME_CONFIG.defaults.updateIssueLog,
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

function booleanEnv(envName: string, fallback?: boolean): boolean | undefined {
  const raw = optionalString(process.env[envName]);
  if (!raw) {
    return fallback;
  }

  const normalized = raw.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }

  throw new Error(`Invalid env ${envName}: must be a boolean like true/false`);
}

function deliveryMethodEnv(envName: string, fallback?: DeliveryMethod): DeliveryMethod | undefined {
  const raw = optionalString(process.env[envName]);
  if (!raw) {
    return fallback;
  }
  return normalizeDeliveryMethod(raw);
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
