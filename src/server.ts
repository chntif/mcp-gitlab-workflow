#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getRuntimeConfig } from "./config.js";
import { CommitActionInput, GitLabClient } from "./gitlab.js";
import {
  WorkType,
  buildBranchName,
  buildDefaultIssueDescription,
  buildIssueTitle,
  detectWorkType,
  renderIssueCompletionComment,
  renderIssueLogEntry,
  renderMergeRequestDescription,
  renderTemplate,
  summarizeRequirement,
} from "./workflow.js";
import {
  gitlabAddIssueCommentOutputSchema,
  gitlabApproveMrOutputSchema,
  gitlabCommitFilesOutputSchema,
  gitlabCreateBranchOutputSchema,
  gitlabCreateLabelOutputSchema,
  gitlabCreateIssueOutputSchema,
  gitlabCreateMergeRequestOutputSchema,
  gitlabCreateMrNoteOutputSchema,
  gitlabDeleteLabelOutputSchema,
  gitlabGetFileOutputSchema,
  gitlabGetCurrentUserOutputSchema,
  gitlabGetIssueImagesOutputSchema,
  gitlabGetIssueNotesOutputSchema,
  gitlabGetIssueOutputSchema,
  gitlabGetMergeRequestOutputSchema,
  gitlabGetMrChangesOutputSchema,
  gitlabGetMrNotesOutputSchema,
  gitlabListLabelsOutputSchema,
  gitlabUpdateLabelOutputSchema,
  gitlabUnapproveMrOutputSchema,
  gitlabUploadProjectFileOutputSchema,
  workflowAddIssueCommentOutputSchema,
  workflowAppendIssueLogOutputSchema,
  workflowCompleteOutputSchema,
  workflowCreateMergeRequestOutputSchema,
  workflowParseRequirementOutputSchema,
  workflowStartOutputSchema,
} from "./output-schemas.js";

const config = getRuntimeConfig();
const gitlab = new GitLabClient({
  apiBaseUrl: config.gitlabApiBaseUrl,
  token: config.gitlabToken,
});

const server = new McpServer({
  name: "mcp-gitlab-workflow",
  version: "1.3.0",
});

class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

function textResult(data: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
  };
}


function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function getLabelStrippedSummary(issueTitle: string): string {
  return issueTitle.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function inferWorkTypeFromBranch(branchName: string): WorkType {
  const prefix = branchName.split("/")[0];
  if (prefix === "fix" || prefix === "chore" || prefix === "feat") {
    return prefix;
  }
  return "feat";
}

function missingParam(toolName: string, fieldName: string, envVarName?: string): never {
  if (envVarName) {
    throw new ToolInputError(
      `[${toolName}] Missing required parameter '${fieldName}'. Provide it in tool args or set env ${envVarName}.`,
    );
  }
  throw new ToolInputError(
    `[${toolName}] Missing required parameter '${fieldName}'. Provide it in tool args.`,
  );
}

function invalidParam(toolName: string, fieldName: string, rule: string): never {
  throw new ToolInputError(`[${toolName}] Invalid parameter '${fieldName}': ${rule}`);
}

function requireNumberParam(
  toolName: string,
  fieldName: string,
  valueFromArgs: number | undefined,
  valueFromEnv: number | undefined,
  envVarName?: string,
): number {
  const candidate = valueFromArgs ?? valueFromEnv;
  if (candidate === undefined) {
    return missingParam(toolName, fieldName, envVarName);
  }
  if (!Number.isInteger(candidate) || candidate <= 0) {
    return invalidParam(toolName, fieldName, "must be a positive integer");
  }
  return candidate;
}

function requireStringParam(
  toolName: string,
  fieldName: string,
  valueFromArgs: string | undefined,
  valueFromEnv: string | undefined,
  envVarName?: string,
): string {
  if (valueFromArgs?.trim()) {
    return valueFromArgs.trim();
  }
  if (valueFromEnv?.trim()) {
    return valueFromEnv.trim();
  }
  return missingParam(toolName, fieldName, envVarName);
}

function optionalStringParam(
  valueFromArgs: string | undefined,
  valueFromEnv: string | undefined,
): string | undefined {
  if (valueFromArgs?.trim()) {
    return valueFromArgs.trim();
  }
  if (valueFromEnv?.trim()) {
    return valueFromEnv.trim();
  }
  return undefined;
}

function normalizeStringArray(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values.map((item) => item.trim()).filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeUniqueStringArray(values: string[] | undefined): string[] | undefined {
  const normalized = normalizeStringArray(values);
  if (!normalized) {
    return undefined;
  }
  return [...new Set(normalized)];
}

function normalizePositiveIntArray(
  toolName: string,
  fieldName: string,
  values: number[] | undefined,
): number[] | undefined {
  if (!values) {
    return undefined;
  }
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0) {
      invalidParam(toolName, fieldName, "must be an array of positive integers");
    }
  }
  return values.length > 0 ? values : undefined;
}

function enforceIssueProjectLock(toolName: string, issueProjectId: number) {
  if (
    config.locks.issueProjectId !== undefined &&
    issueProjectId !== config.locks.issueProjectId
  ) {
    throw new ToolInputError(
      `[${toolName}] project_id=${issueProjectId} does not match locked WORKFLOW_LOCK_ISSUE_PROJECT_ID=${config.locks.issueProjectId}.`,
    );
  }
}

function enforceCodeProjectLock(toolName: string, codeProjectId: number) {
  if (
    config.locks.codeProjectId !== undefined &&
    codeProjectId !== config.locks.codeProjectId
  ) {
    throw new ToolInputError(
      `[${toolName}] project_id=${codeProjectId} does not match locked WORKFLOW_LOCK_CODE_PROJECT_ID=${config.locks.codeProjectId}.`,
    );
  }
}

function enforceProjectLocks(toolName: string, issueProjectId: number, codeProjectId: number) {
  enforceIssueProjectLock(toolName, issueProjectId);
  enforceCodeProjectLock(toolName, codeProjectId);
}

function enforceAnyLockedProject(toolName: string, projectId: number) {
  const allowedProjectIds = [config.locks.issueProjectId, config.locks.codeProjectId].filter(
    (value): value is number => value !== undefined,
  );
  if (allowedProjectIds.length === 0) {
    return;
  }
  if (allowedProjectIds.includes(projectId)) {
    return;
  }
  throw new ToolInputError(
    `[${toolName}] project_id=${projectId} does not match any locked project id (${allowedProjectIds.join(", ")}).`,
  );
}

function toErrorPayload(toolName: string, error: unknown) {
  if (error instanceof ToolInputError) {
    return {
      ok: false,
      tool: toolName,
      error_type: "input_error",
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return {
      ok: false,
      tool: toolName,
      error_type: "runtime_error",
      message: error.message,
    };
  }
  return {
    ok: false,
    tool: toolName,
    error_type: "unknown_error",
    message: String(error),
  };
}

function withToolErrorHandling<TArgs>(
  toolName: string,
  handler: (args: TArgs) => Promise<unknown>,
) {
  return async (args: TArgs) => {
    try {
      const data = await handler(args);
      return textResult({ ok: true, tool: toolName, data });
    } catch (error) {
      return textResult(toErrorPayload(toolName, error));
    }
  };
}

async function appendMarkdown(logPath: string, markdown: string): Promise<string> {
  const absolutePath = resolve(process.cwd(), logPath);
  await mkdir(dirname(absolutePath), { recursive: true });

  let content = "";
  try {
    content = await readFile(absolutePath, "utf8");
  } catch {
    content = "";
  }

  const spacer = content.endsWith("\n\n") || content.length === 0 ? "" : "\n";
  await writeFile(absolutePath, `${content}${spacer}${markdown}`, "utf8");
  return absolutePath;
}

async function updateIssueLogWithMr(params: {
  logPath: string;
  issueIid: number;
  mrIid: number;
  mrUrl: string;
  status: string;
}): Promise<string> {
  const absolutePath = resolve(process.cwd(), params.logPath);
  await mkdir(dirname(absolutePath), { recursive: true });

  let content = "";
  try {
    content = await readFile(absolutePath, "utf8");
  } catch {
    content = "";
  }

  const issuePattern = new RegExp(
    "(## \\[[^\\]]+\\][\\s\\S]*?\\| Issue ID \\(iid\\) \\| `" +
      params.issueIid +
      "` \\|[\\s\\S]*?)(\\n\\*\\*[^\\n]+\\*\\*:?)",
    "m",
  );

  if (!issuePattern.test(content)) {
    const fallback = `\n## [${getTodayDateString()}] Issue ${params.issueIid} status update

| Field | Value |
|------|-----|
| Issue ID (iid) | \`${params.issueIid}\` |
| MR ID | \`${params.mrIid}\` |
| MR URL | \`${params.mrUrl}\` |
| Status | ${params.status} |

---\n`;
    await writeFile(absolutePath, `${content}${fallback}`, "utf8");
    return absolutePath;
  }

  const statusRowRegex = /\| Status \| .*? \|/;
  const updated = content.replace(issuePattern, (_full, sectionPrefix, marker) => {
    let section = sectionPrefix as string;
    if (!/\| MR ID \|/.test(section)) {
      section = section.replace(
        statusRowRegex,
        `| MR ID | \`${params.mrIid}\` |\n| MR URL | \`${params.mrUrl}\` |\n| Status | ${params.status} |`,
      );
    } else {
      section = section
        .replace(/\| MR ID \| .*? \|/, `| MR ID | \`${params.mrIid}\` |`)
        .replace(/\| MR URL \| .*? \|/, `| MR URL | \`${params.mrUrl}\` |`)
        .replace(statusRowRegex, `| Status | ${params.status} |`);
    }
    return `${section}${marker}`;
  });

  await writeFile(absolutePath, updated, "utf8");
  return absolutePath;
}

async function resolveAssigneeIdsFromUsername(username: string | undefined): Promise<number[] | undefined> {
  if (!username) {
    return undefined;
  }
  const id = await gitlab.findUserIdByUsername(username);
  if (!id) {
    throw new ToolInputError(`Assignee username '${username}' was not found in GitLab.`);
  }
  return [id];
}

async function resolveAssigneeIdsFromUsernames(
  toolName: string,
  usernames: string[] | undefined,
): Promise<number[] | undefined> {
  const normalized = normalizeUniqueStringArray(usernames);
  if (!normalized || normalized.length === 0) {
    return undefined;
  }

  const userIds: number[] = [];
  for (const username of normalized) {
    const id = await gitlab.findUserIdByUsername(username);
    if (!id) {
      throw new ToolInputError(`[${toolName}] assignee username '${username}' was not found in GitLab.`);
    }
    userIds.push(id);
  }

  return [...new Set(userIds)];
}

async function resolveIssueAssigneeIds(toolName: string, params: {
  assigneeIds?: number[];
  assigneeUsernames?: string[];
  assigneeUsername?: string;
  assignToCurrentUserIfMissing?: boolean;
}): Promise<number[] | undefined> {
  const assigneeIds = normalizePositiveIntArray(toolName, "assignee_ids", params.assigneeIds);
  if (assigneeIds && assigneeIds.length > 0) {
    return assigneeIds;
  }

  const usernameCandidates = normalizeUniqueStringArray([
    ...(params.assigneeUsernames ?? []),
    ...(params.assigneeUsername ? [params.assigneeUsername] : []),
  ]);
  const usernameResolvedIds = await resolveAssigneeIdsFromUsernames(toolName, usernameCandidates);
  if (usernameResolvedIds && usernameResolvedIds.length > 0) {
    return usernameResolvedIds;
  }

  if (params.assignToCurrentUserIfMissing) {
    const currentUser = await gitlab.getCurrentUser();
    if (!currentUser || !Number.isInteger(currentUser.id) || currentUser.id <= 0) {
      throw new ToolInputError(
        `[${toolName}] Failed to resolve current authenticated GitLab user id for default assignee.`,
      );
    }
    return [currentUser.id];
  }

  return undefined;
}

function ensureIsoDate(toolName: string, fieldName: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    invalidParam(toolName, fieldName, "must be in YYYY-MM-DD format");
  }
  return trimmed;
}

function ensureHexColor(toolName: string, fieldName: string, value: string): string {
  const normalized = value.trim();
  if (!/^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(normalized)) {
    return invalidParam(toolName, fieldName, "must be a valid hex color like #FF8800");
  }
  return normalized;
}

function ensurePositiveIntOptional(
  toolName: string,
  fieldName: string,
  value: number | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    return invalidParam(toolName, fieldName, "must be a positive integer");
  }
  return value;
}

function ensurePositiveIntRangeOptional(
  toolName: string,
  fieldName: string,
  value: number | undefined,
  max: number,
): number | undefined {
  const parsed = ensurePositiveIntOptional(toolName, fieldName, value);
  if (parsed === undefined) {
    return undefined;
  }
  if (parsed > max) {
    return invalidParam(toolName, fieldName, `must be <= ${max}`);
  }
  return parsed;
}

type ParsedImageRef = {
  altText?: string;
  rawUrl: string;
  markdownFragment: string;
};

function extractImageReferences(markdownOrHtml: string): ParsedImageRef[] {
  const results: ParsedImageRef[] = [];
  if (!markdownOrHtml) {
    return results;
  }

  const markdownRegex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = markdownRegex.exec(markdownOrHtml)) !== null) {
    const [, altText, rawUrl] = markdownMatch;
    results.push({
      altText: altText?.trim() || undefined,
      rawUrl: rawUrl.trim(),
      markdownFragment: markdownMatch[0],
    });
  }

  const htmlRegex = /<img[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let htmlMatch: RegExpExecArray | null;
  while ((htmlMatch = htmlRegex.exec(markdownOrHtml)) !== null) {
    const src = htmlMatch[1]?.trim();
    if (!src) {
      continue;
    }

    const altMatch = /alt=["']([^"']*)["']/i.exec(htmlMatch[0]);
    results.push({
      altText: altMatch?.[1]?.trim() || undefined,
      rawUrl: src,
      markdownFragment: htmlMatch[0],
    });
  }

  return results;
}

function validateCommitActions(toolName: string, actions: CommitActionInput[]) {
  if (actions.length === 0) {
    missingParam(toolName, "actions");
  }

  actions.forEach((action, index) => {
    const prefix = `actions[${index}]`;

    if (!action.file_path?.trim()) {
      invalidParam(toolName, `${prefix}.file_path`, "is required");
    }

    if (action.action === "move" && !action.previous_path?.trim()) {
      invalidParam(toolName, `${prefix}.previous_path`, "is required when action='move'");
    }

    if ((action.action === "create" || action.action === "update") && action.content === undefined) {
      invalidParam(toolName, `${prefix}.content`, "is required when action is create/update");
    }

    if (action.action === "chmod" && action.execute_filemode === undefined) {
      invalidParam(toolName, `${prefix}.execute_filemode`, "is required when action='chmod'");
    }
  });
}

async function createWorkflowMergeRequest(params: {
  issueProjectId: number;
  issueProjectPath?: string;
  issueIid: number;
  codeProjectId: number;
  sourceBranch: string;
  targetBranch: string;
  mergeRequestTitle?: string;
  workType?: WorkType;
  summary?: string;
  changeSummary: string;
  testPlan: string;
  label?: string;
  assigneeUsername?: string;
  removeSourceBranch?: boolean;
  squash?: boolean;
  draft?: boolean;
}): Promise<any> {
  const issue = await gitlab.getIssue(params.issueProjectId, params.issueIid);
  const summary = params.summary ?? getLabelStrippedSummary(issue.title ?? "");
  const workType = params.workType ?? inferWorkTypeFromBranch(params.sourceBranch);
  const title = params.mergeRequestTitle || `${workType}: ${summary}`;
  const description = renderMergeRequestDescription({
    issueProjectPath: params.issueProjectPath,
    issueProjectId: params.issueProjectId,
    issueIid: params.issueIid,
    changeSummary: params.changeSummary,
    testPlan: params.testPlan,
  });

  const assigneeIds = await resolveAssigneeIdsFromUsername(params.assigneeUsername);

  return gitlab.createMergeRequest({
    projectId: params.codeProjectId,
    sourceBranch: params.sourceBranch,
    targetBranch: params.targetBranch,
    title,
    description,
    labels: params.label ? [params.label] : undefined,
    assigneeIds,
    removeSourceBranch: params.removeSourceBranch,
    squash: params.squash,
    draft: params.draft,
  });
}

const commitActionSchema = z.object({
  action: z
    .enum(["create", "delete", "move", "update", "chmod"])
    .describe("GitLab commit action type."),
  file_path: z
    .string()
    .optional()
    .describe("Target path in repository. Required for all actions."),
  previous_path: z
    .string()
    .optional()
    .describe("Old path when action is 'move'."),
  content: z
    .string()
    .optional()
    .describe("File content for create/update actions."),
  encoding: z
    .enum(["text", "base64"])
    .optional()
    .describe("Optional content encoding."),
  execute_filemode: z
    .boolean()
    .optional()
    .describe("Required for chmod action."),
  last_commit_id: z
    .string()
    .optional()
    .describe("Optional optimistic lock commit id."),
});

// TOOL REGISTRATION START

server.registerTool(
  "workflow_parse_requirement",
  {
    description:
      "Parse requirement text into work_type, issue_title, commit_type, and branch_name.",
    outputSchema: workflowParseRequirementOutputSchema,
    inputSchema: {
      requirement_text: z.string().min(1).describe("Raw user requirement text."),
      english_slug: z
        .string()
        .optional()
        .describe("Optional English slug used for branch name, e.g. 'asset-export'."),
      work_type: z
        .enum(["feat", "fix", "chore"])
        .optional()
        .describe("Optional override for work type."),
      summary: z
        .string()
        .optional()
        .describe("Optional short summary used in issue title."),
      label: z
        .string()
        .optional()
        .describe("Optional label prefix for title, e.g. 'frontend'."),
    },
  },
  withToolErrorHandling("workflow_parse_requirement", async (args) => {
    const parsedWorkType = args.work_type ?? detectWorkType(args.requirement_text);
    const issueSummary = args.summary ?? summarizeRequirement(args.requirement_text, 30);
    const issueTitle = buildIssueTitle(issueSummary, args.label);
    const branchName = buildBranchName({
      workType: parsedWorkType,
      englishSlug: args.english_slug,
      requirementText: args.requirement_text,
    });

    return {
      work_type: parsedWorkType,
      commit_type: parsedWorkType,
      summary: issueSummary,
      issue_title: issueTitle,
      branch_name: branchName,
    };
  }),
);

server.registerTool(
  "workflow_start",
  {
    description:
      "Create issue + create branch + optional local issue log append. No project/branch hardcoded defaults.",
    outputSchema: workflowStartOutputSchema,
    inputSchema: {
      requirement_text: z.string().min(1).describe("Raw user requirement text."),
      source_text: z.string().optional().describe("Background/source text for issue template."),
      expected_behavior: z.string().optional().describe("Expected behavior (used by default template)."),
      current_behavior: z.string().optional().describe("Current behavior (optional)."),
      given: z.string().optional().describe("GIVEN clause for acceptance criteria."),
      when: z.string().optional().describe("WHEN clause for acceptance criteria."),
      then: z.string().optional().describe("THEN clause for acceptance criteria."),
      issue_template: z
        .string()
        .optional()
        .describe("Optional issue markdown template. Supports variables like {{summary}}."),
      template_variables: z
        .record(z.string())
        .optional()
        .describe("Optional custom variables map merged into issue_template rendering."),
      english_slug: z.string().optional().describe("Optional branch slug."),
      work_type: z.enum(["feat", "fix", "chore"]).optional().describe("Optional work type override."),
      summary: z.string().optional().describe("Optional issue summary."),
      issue_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Issue project ID. If omitted, env WORKFLOW_ISSUE_PROJECT_ID is used."),
      issue_project_path: z
        .string()
        .optional()
        .describe("Issue project path for links/logs (optional)."),
      code_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Code project ID. If omitted, env WORKFLOW_CODE_PROJECT_ID is used."),
      code_project_path: z
        .string()
        .optional()
        .describe("Code project path for logs/comments (optional)."),
      base_branch: z
        .string()
        .optional()
        .describe("Base branch used to create new branch. If omitted, env WORKFLOW_BASE_BRANCH is used."),
      label: z.string().optional().describe("Issue label (optional)."),
      assignee_username: z
        .string()
        .optional()
        .describe("GitLab username to resolve as assignee (optional)."),
      assignee_usernames: z
        .array(z.string())
        .optional()
        .describe("Optional assignee GitLab usernames. Resolved to assignee_ids internally."),
      assign_to_current_user_if_missing: z
        .boolean()
        .optional()
        .describe("When true, assign issue to current token user if no assignee is provided."),
      append_log: z
        .boolean()
        .optional()
        .describe("Whether to append a local issue log entry."),
      log_path: z
        .string()
        .optional()
        .describe("Issue log file path. Required when append_log=true unless env WORKFLOW_ISSUE_LOG_PATH is set."),
    },
  },
  withToolErrorHandling("workflow_start", async (args) => {
    const issueProjectId = requireNumberParam(
      "workflow_start",
      "issue_project_id",
      args.issue_project_id,
      config.defaults.issueProjectId,
      "WORKFLOW_ISSUE_PROJECT_ID",
    );
    const codeProjectId = requireNumberParam(
      "workflow_start",
      "code_project_id",
      args.code_project_id,
      config.defaults.codeProjectId,
      "WORKFLOW_CODE_PROJECT_ID",
    );
    enforceProjectLocks("workflow_start", issueProjectId, codeProjectId);

    const baseBranch = requireStringParam(
      "workflow_start",
      "base_branch",
      args.base_branch,
      config.defaults.baseBranch,
      "WORKFLOW_BASE_BRANCH",
    );

    const issueProjectPath = optionalStringParam(args.issue_project_path, config.defaults.issueProjectPath);
    const codeProjectPath = optionalStringParam(args.code_project_path, config.defaults.codeProjectPath);
    const label = optionalStringParam(args.label, config.defaults.label);
    const assigneeUsername = optionalStringParam(args.assignee_username, config.defaults.assigneeUsername);

    const parsedWorkType = args.work_type ?? detectWorkType(args.requirement_text);
    const issueSummary = args.summary ?? summarizeRequirement(args.requirement_text, 30);
    const issueTitle = buildIssueTitle(issueSummary, label);
    const branchName = buildBranchName({
      workType: parsedWorkType,
      englishSlug: args.english_slug,
      requirementText: args.requirement_text,
    });

    const issueDescription = (() => {
      if (args.issue_template) {
        const variables = {
          requirement_text: args.requirement_text,
          summary: issueSummary,
          source_text: args.source_text ?? args.requirement_text,
          expected_behavior: args.expected_behavior ?? "",
          current_behavior: args.current_behavior ?? "",
          given: args.given ?? "",
          when: args.when ?? "",
          then: args.then ?? "",
          issue_project_id: String(issueProjectId),
          code_project_id: String(codeProjectId),
          issue_project_path: issueProjectPath ?? "",
          code_project_path: codeProjectPath ?? "",
          branch_name: branchName,
          work_type: parsedWorkType,
          label: label ?? "",
        };
        return renderTemplate(args.issue_template, {
          ...variables,
          ...(args.template_variables ?? {}),
        });
      }

      if (!args.expected_behavior) {
        missingParam("workflow_start", "expected_behavior");
      }
      if (!args.given) {
        missingParam("workflow_start", "given");
      }
      if (!args.when) {
        missingParam("workflow_start", "when");
      }
      if (!args.then) {
        missingParam("workflow_start", "then");
      }

      return buildDefaultIssueDescription({
        sourceText: args.source_text ?? args.requirement_text,
        expectedBehavior: args.expected_behavior,
        currentBehavior: args.current_behavior,
        given: args.given,
        when: args.when,
        then: args.then,
        repoPath: codeProjectPath,
      });
    })();

    const assigneeIds = await resolveIssueAssigneeIds("workflow_start", {
      assigneeUsernames: args.assignee_usernames,
      assigneeUsername,
      assignToCurrentUserIfMissing: args.assign_to_current_user_if_missing ?? true,
    });
    const issue = await gitlab.createIssue({
      projectId: issueProjectId,
      title: issueTitle,
      description: issueDescription,
      labels: label ? [label] : undefined,
      assigneeIds,
    });

    const branch = await gitlab.createBranch(codeProjectId, branchName, baseBranch);

    let logResult: { updated: boolean; path?: string } = { updated: false };
    if (args.append_log) {
      const logPath = requireStringParam(
        "workflow_start",
        "log_path",
        args.log_path,
        config.defaults.issueLogPath,
        "WORKFLOW_ISSUE_LOG_PATH",
      );
      const markdown = renderIssueLogEntry({
        date: getTodayDateString(),
        issueTitle,
        issueIid: issue.iid,
        issueProjectPath,
        issueProjectId,
        issueWebUrl: issue.web_url,
        branchName,
        codeProjectPath,
        codeProjectId,
        summary: issueSummary,
        status: "in_progress",
      });
      const path = await appendMarkdown(logPath, markdown);
      logResult = { updated: true, path };
    }

    return {
      parsed: {
        work_type: parsedWorkType,
        summary: issueSummary,
        issue_title: issueTitle,
        branch_name: branchName,
      },
      issue: {
        id: issue.id,
        iid: issue.iid,
        web_url: issue.web_url,
      },
      branch: {
        name: branch.name,
        web_url: branch.web_url,
      },
      log: logResult,
    };
  }),
);

server.registerTool(
  "workflow_append_issue_log",
  {
    description: "Append one issue record to local issue log markdown file.",
    outputSchema: workflowAppendIssueLogOutputSchema,
    inputSchema: {
      issue_title: z.string().min(1).describe("Issue title."),
      issue_iid: z.number().int().positive().describe("Issue IID."),
      issue_web_url: z.string().min(1).describe("Issue web URL."),
      branch_name: z.string().min(1).describe("Code branch name."),
      summary: z.string().min(1).describe("Short issue summary."),
      status: z.string().min(1).describe("Status text."),
      issue_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Issue project ID. If omitted, env WORKFLOW_ISSUE_PROJECT_ID is used."),
      issue_project_path: z.string().optional().describe("Issue project path."),
      code_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Code project ID. If omitted, env WORKFLOW_CODE_PROJECT_ID is used."),
      code_project_path: z.string().optional().describe("Code project path."),
      log_path: z
        .string()
        .optional()
        .describe("Issue log path. If omitted, env WORKFLOW_ISSUE_LOG_PATH is used."),
    },
  },
  withToolErrorHandling("workflow_append_issue_log", async (args) => {
    const issueProjectId = requireNumberParam(
      "workflow_append_issue_log",
      "issue_project_id",
      args.issue_project_id,
      config.defaults.issueProjectId,
      "WORKFLOW_ISSUE_PROJECT_ID",
    );
    const codeProjectId = requireNumberParam(
      "workflow_append_issue_log",
      "code_project_id",
      args.code_project_id,
      config.defaults.codeProjectId,
      "WORKFLOW_CODE_PROJECT_ID",
    );
    enforceProjectLocks("workflow_append_issue_log", issueProjectId, codeProjectId);

    const logPath = requireStringParam(
      "workflow_append_issue_log",
      "log_path",
      args.log_path,
      config.defaults.issueLogPath,
      "WORKFLOW_ISSUE_LOG_PATH",
    );
    const issueProjectPath = optionalStringParam(args.issue_project_path, config.defaults.issueProjectPath);
    const codeProjectPath = optionalStringParam(args.code_project_path, config.defaults.codeProjectPath);

    const markdown = renderIssueLogEntry({
      date: getTodayDateString(),
      issueTitle: args.issue_title,
      issueIid: args.issue_iid,
      issueProjectPath,
      issueProjectId,
      issueWebUrl: args.issue_web_url,
      branchName: args.branch_name,
      codeProjectPath,
      codeProjectId,
      summary: args.summary,
      status: args.status,
    });

    const path = await appendMarkdown(logPath, markdown);
    return { updated: true, path };
  }),
);

server.registerTool(
  "workflow_add_issue_comment",
  {
    description: "Add issue comment using direct body or generated completion-comment template.",
    outputSchema: workflowAddIssueCommentOutputSchema,
    inputSchema: {
      issue_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Issue project ID. If omitted, env WORKFLOW_ISSUE_PROJECT_ID is used."),
      issue_iid: z.number().int().positive().describe("Issue IID."),
      body: z
        .string()
        .optional()
        .describe("Direct comment markdown. If provided, generated-comment fields are ignored."),
      changed_files: z.array(z.string()).optional().describe("Changed file list for generated comment."),
      branch_name: z.string().optional().describe("Branch name for generated comment."),
      code_project_path: z.string().optional().describe("Code project path for generated comment."),
      implementation_summary: z.string().optional().describe("Implementation notes for generated comment."),
      acceptance_steps: z.string().optional().describe("Validation steps for generated comment."),
    },
  },
  withToolErrorHandling("workflow_add_issue_comment", async (args) => {
    const issueProjectId = requireNumberParam(
      "workflow_add_issue_comment",
      "issue_project_id",
      args.issue_project_id,
      config.defaults.issueProjectId,
      "WORKFLOW_ISSUE_PROJECT_ID",
    );
    enforceIssueProjectLock("workflow_add_issue_comment", issueProjectId);

    const codeProjectPath = optionalStringParam(args.code_project_path, config.defaults.codeProjectPath);
    const body = (() => {
      if (args.body) {
        return args.body;
      }
      if (!args.branch_name) {
        missingParam("workflow_add_issue_comment", "branch_name");
      }
      if (!args.implementation_summary) {
        missingParam("workflow_add_issue_comment", "implementation_summary");
      }
      if (!args.acceptance_steps) {
        missingParam("workflow_add_issue_comment", "acceptance_steps");
      }
      return renderIssueCompletionComment({
        changedFiles: args.changed_files ?? [],
        branchName: args.branch_name,
        codeProjectPath,
        implementationSummary: args.implementation_summary,
        acceptanceSteps: args.acceptance_steps,
      });
    })();

    const note = await gitlab.createIssueNote(issueProjectId, args.issue_iid, body);
    return {
      issue_iid: args.issue_iid,
      note_id: note.id,
      body,
      web_url: note?.noteable_url ?? null,
    };
  }),
);

server.registerTool(
  "workflow_create_merge_request",
  {
    description:
      "Create merge request and optionally update local issue log status. No hardcoded project or branch values.",
    outputSchema: workflowCreateMergeRequestOutputSchema,
    inputSchema: {
      issue_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Issue project ID. If omitted, env WORKFLOW_ISSUE_PROJECT_ID is used."),
      issue_project_path: z.string().optional().describe("Issue project path."),
      issue_iid: z.number().int().positive().describe("Issue IID."),
      code_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Code project ID. If omitted, env WORKFLOW_CODE_PROJECT_ID is used."),
      branch_name: z.string().min(1).describe("Source branch name."),
      target_branch: z
        .string()
        .optional()
        .describe("Target branch. If omitted, env WORKFLOW_TARGET_BRANCH is used."),
      change_summary: z.string().min(1).describe("MR change summary section."),
      test_plan: z.string().min(1).describe("MR test plan section."),
      merge_request_title: z.string().optional().describe("Optional MR title override."),
      work_type: z.enum(["feat", "fix", "chore"]).optional().describe("Optional work type override."),
      summary: z.string().optional().describe("Optional short summary used for title."),
      label: z.string().optional().describe("Optional MR label."),
      assignee_username: z.string().optional().describe("Optional assignee username."),
      remove_source_branch: z.boolean().optional().describe("Pass-through to GitLab MR API."),
      squash: z.boolean().optional().describe("Pass-through to GitLab MR API."),
      draft: z.boolean().optional().describe("Create MR as draft."),
      update_log: z.boolean().optional().describe("Whether to update local issue log."),
      log_path: z.string().optional().describe("Issue log path."),
      log_status: z.string().optional().describe("Status text written into issue log."),
    },
  },
  withToolErrorHandling("workflow_create_merge_request", async (args) => {
    const issueProjectId = requireNumberParam(
      "workflow_create_merge_request",
      "issue_project_id",
      args.issue_project_id,
      config.defaults.issueProjectId,
      "WORKFLOW_ISSUE_PROJECT_ID",
    );
    const codeProjectId = requireNumberParam(
      "workflow_create_merge_request",
      "code_project_id",
      args.code_project_id,
      config.defaults.codeProjectId,
      "WORKFLOW_CODE_PROJECT_ID",
    );
    enforceProjectLocks("workflow_create_merge_request", issueProjectId, codeProjectId);

    const targetBranch = requireStringParam(
      "workflow_create_merge_request",
      "target_branch",
      args.target_branch,
      config.defaults.targetBranch,
      "WORKFLOW_TARGET_BRANCH",
    );
    const issueProjectPath = optionalStringParam(args.issue_project_path, config.defaults.issueProjectPath);
    const label = optionalStringParam(args.label, config.defaults.label);
    const assigneeUsername = optionalStringParam(args.assignee_username, config.defaults.assigneeUsername);

    const mr = await createWorkflowMergeRequest({
      issueProjectId,
      issueProjectPath,
      issueIid: args.issue_iid,
      codeProjectId,
      sourceBranch: args.branch_name,
      targetBranch,
      mergeRequestTitle: args.merge_request_title,
      workType: args.work_type,
      summary: args.summary,
      changeSummary: args.change_summary,
      testPlan: args.test_plan,
      label,
      assigneeUsername,
      removeSourceBranch: args.remove_source_branch,
      squash: args.squash,
      draft: args.draft,
    });

    let log: { updated: boolean; path?: string } = { updated: false };
    if (args.update_log) {
      const logPath = requireStringParam(
        "workflow_create_merge_request",
        "log_path",
        args.log_path,
        config.defaults.issueLogPath,
        "WORKFLOW_ISSUE_LOG_PATH",
      );
      const logStatus = args.log_status ?? "mr_pending_review";
      const path = await updateIssueLogWithMr({
        logPath,
        issueIid: args.issue_iid,
        mrIid: mr.iid,
        mrUrl: mr.web_url,
        status: logStatus,
      });
      log = { updated: true, path };
    }

    return {
      merge_request: {
        id: mr.id,
        iid: mr.iid,
        title: mr.title,
        web_url: mr.web_url,
      },
      log,
    };
  }),
);

server.registerTool(
  "workflow_complete",
  {
    description:
      "Complete workflow in one call: add issue comment + create MR + optional local issue-log status update.",
    outputSchema: workflowCompleteOutputSchema,
    inputSchema: {
      issue_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Issue project ID. If omitted, env WORKFLOW_ISSUE_PROJECT_ID is used."),
      issue_project_path: z.string().optional().describe("Issue project path."),
      issue_iid: z.number().int().positive().describe("Issue IID."),
      issue_comment_body: z
        .string()
        .optional()
        .describe("Direct issue comment markdown. If missing, template fields are used."),
      changed_files: z.array(z.string()).optional().describe("Changed file list for generated issue comment."),
      implementation_summary: z
        .string()
        .optional()
        .describe("Implementation notes for generated issue comment."),
      acceptance_steps: z.string().optional().describe("Validation steps for generated issue comment."),
      code_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Code project ID. If omitted, env WORKFLOW_CODE_PROJECT_ID is used."),
      code_project_path: z.string().optional().describe("Code project path."),
      branch_name: z.string().min(1).describe("Source branch name."),
      target_branch: z
        .string()
        .optional()
        .describe("Target branch. If omitted, env WORKFLOW_TARGET_BRANCH is used."),
      change_summary: z.string().min(1).describe("MR change summary section."),
      test_plan: z.string().min(1).describe("MR test plan section."),
      merge_request_title: z.string().optional().describe("Optional MR title override."),
      work_type: z.enum(["feat", "fix", "chore"]).optional().describe("Optional work type override."),
      summary: z.string().optional().describe("Optional short summary for MR title."),
      label: z.string().optional().describe("Optional issue/MR label."),
      assignee_username: z.string().optional().describe("Optional assignee username."),
      remove_source_branch: z.boolean().optional().describe("Pass-through to GitLab MR API."),
      squash: z.boolean().optional().describe("Pass-through to GitLab MR API."),
      draft: z.boolean().optional().describe("Create MR as draft."),
      update_log: z.boolean().optional().describe("Whether to update local issue log."),
      log_path: z.string().optional().describe("Issue log path."),
      log_status: z.string().optional().describe("Status text written into issue log."),
    },
  },
  withToolErrorHandling("workflow_complete", async (args) => {
    const issueProjectId = requireNumberParam(
      "workflow_complete",
      "issue_project_id",
      args.issue_project_id,
      config.defaults.issueProjectId,
      "WORKFLOW_ISSUE_PROJECT_ID",
    );
    const codeProjectId = requireNumberParam(
      "workflow_complete",
      "code_project_id",
      args.code_project_id,
      config.defaults.codeProjectId,
      "WORKFLOW_CODE_PROJECT_ID",
    );
    enforceProjectLocks("workflow_complete", issueProjectId, codeProjectId);

    const issueProjectPath = optionalStringParam(args.issue_project_path, config.defaults.issueProjectPath);
    const codeProjectPath = optionalStringParam(args.code_project_path, config.defaults.codeProjectPath);
    const label = optionalStringParam(args.label, config.defaults.label);
    const assigneeUsername = optionalStringParam(args.assignee_username, config.defaults.assigneeUsername);
    const targetBranch = requireStringParam(
      "workflow_complete",
      "target_branch",
      args.target_branch,
      config.defaults.targetBranch,
      "WORKFLOW_TARGET_BRANCH",
    );

    const issueCommentBody = (() => {
      if (args.issue_comment_body) {
        return args.issue_comment_body;
      }
      if (!args.implementation_summary) {
        missingParam("workflow_complete", "implementation_summary");
      }
      if (!args.acceptance_steps) {
        missingParam("workflow_complete", "acceptance_steps");
      }
      return renderIssueCompletionComment({
        changedFiles: args.changed_files ?? [],
        branchName: args.branch_name,
        codeProjectPath,
        implementationSummary: args.implementation_summary,
        acceptanceSteps: args.acceptance_steps,
      });
    })();

    const issueNote = await gitlab.createIssueNote(issueProjectId, args.issue_iid, issueCommentBody);

    const mr = await createWorkflowMergeRequest({
      issueProjectId,
      issueProjectPath,
      issueIid: args.issue_iid,
      codeProjectId,
      sourceBranch: args.branch_name,
      targetBranch,
      mergeRequestTitle: args.merge_request_title,
      workType: args.work_type,
      summary: args.summary,
      changeSummary: args.change_summary,
      testPlan: args.test_plan,
      label,
      assigneeUsername,
      removeSourceBranch: args.remove_source_branch,
      squash: args.squash,
      draft: args.draft,
    });

    let log: { updated: boolean; path?: string } = { updated: false };
    if (args.update_log) {
      const logPath = requireStringParam(
        "workflow_complete",
        "log_path",
        args.log_path,
        config.defaults.issueLogPath,
        "WORKFLOW_ISSUE_LOG_PATH",
      );
      const logStatus = args.log_status ?? "mr_pending_review";
      const path = await updateIssueLogWithMr({
        logPath,
        issueIid: args.issue_iid,
        mrIid: mr.iid,
        mrUrl: mr.web_url,
        status: logStatus,
      });
      log = { updated: true, path };
    }

    return {
      issue_comment: {
        note_id: issueNote.id,
      },
      merge_request: {
        id: mr.id,
        iid: mr.iid,
        title: mr.title,
        web_url: mr.web_url,
      },
      log,
    };
  }),
);

server.registerTool(
  "gitlab_get_current_user",
  {
    description: "Get current authenticated GitLab user (/user).",
    outputSchema: gitlabGetCurrentUserOutputSchema,
    inputSchema: {},
  },
  withToolErrorHandling("gitlab_get_current_user", async () => {
    return gitlab.getCurrentUser();
  }),
);

server.registerTool(
  "gitlab_list_labels",
  {
    description: "List labels of a GitLab project (/projects/:id/labels).",
    outputSchema: gitlabListLabelsOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      search: z.string().optional().describe("Search text for label name/description."),
      page: z.number().int().positive().optional().describe("Page number."),
      per_page: z.number().int().positive().optional().describe("Items per page."),
      with_counts: z.boolean().optional().describe("Whether to include issue counts."),
      include_ancestor_groups: z
        .boolean()
        .optional()
        .describe("Whether to include ancestor group labels."),
    },
  },
  withToolErrorHandling("gitlab_list_labels", async (args) => {
    const projectId = requireNumberParam("gitlab_list_labels", "project_id", args.project_id, undefined);
    enforceAnyLockedProject("gitlab_list_labels", projectId);
    const page = ensurePositiveIntOptional("gitlab_list_labels", "page", args.page);
    const perPage = ensurePositiveIntOptional("gitlab_list_labels", "per_page", args.per_page);
    return gitlab.listLabels(projectId, {
      search: args.search?.trim(),
      page,
      perPage,
      withCounts: args.with_counts,
      includeAncestorGroups: args.include_ancestor_groups,
    });
  }),
);

server.registerTool(
  "gitlab_create_label",
  {
    description: "Create a project label (/projects/:id/labels).",
    outputSchema: gitlabCreateLabelOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      name: z.string().optional().describe("Label name."),
      color: z.string().optional().describe("Label color, e.g. #FF8800."),
      description: z.string().optional().describe("Label description."),
      priority: z.number().int().positive().optional().describe("Label priority."),
    },
  },
  withToolErrorHandling("gitlab_create_label", async (args) => {
    const projectId = requireNumberParam("gitlab_create_label", "project_id", args.project_id, undefined);
    const name = requireStringParam("gitlab_create_label", "name", args.name, undefined);
    const color = ensureHexColor(
      "gitlab_create_label",
      "color",
      requireStringParam("gitlab_create_label", "color", args.color, undefined),
    );
    const priority = ensurePositiveIntOptional("gitlab_create_label", "priority", args.priority);
    enforceAnyLockedProject("gitlab_create_label", projectId);
    return gitlab.createLabel({
      projectId,
      name,
      color,
      description: args.description?.trim(),
      priority,
    });
  }),
);

server.registerTool(
  "gitlab_update_label",
  {
    description: "Update a project label (/projects/:id/labels).",
    outputSchema: gitlabUpdateLabelOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      name: z.string().optional().describe("Existing label name."),
      new_name: z.string().optional().describe("New label name."),
      color: z.string().optional().describe("New color, e.g. #00AAFF."),
      description: z.string().optional().describe("New label description."),
      priority: z.number().int().positive().optional().describe("New label priority."),
    },
  },
  withToolErrorHandling("gitlab_update_label", async (args) => {
    const projectId = requireNumberParam("gitlab_update_label", "project_id", args.project_id, undefined);
    const name = requireStringParam("gitlab_update_label", "name", args.name, undefined);
    const priority = ensurePositiveIntOptional("gitlab_update_label", "priority", args.priority);
    const color = args.color
      ? ensureHexColor("gitlab_update_label", "color", args.color)
      : undefined;
    if (!args.new_name && !args.color && args.description === undefined && priority === undefined) {
      invalidParam(
        "gitlab_update_label",
        "new_name|color|description|priority",
        "at least one update field is required",
      );
    }
    enforceAnyLockedProject("gitlab_update_label", projectId);
    return gitlab.updateLabel({
      projectId,
      name,
      newName: args.new_name?.trim(),
      color,
      description: args.description?.trim(),
      priority,
    });
  }),
);

server.registerTool(
  "gitlab_delete_label",
  {
    description: "Delete a project label (/projects/:id/labels/:label_id).",
    outputSchema: gitlabDeleteLabelOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      label_name: z.string().optional().describe("Label name to delete."),
    },
  },
  withToolErrorHandling("gitlab_delete_label", async (args) => {
    const projectId = requireNumberParam("gitlab_delete_label", "project_id", args.project_id, undefined);
    const labelName = requireStringParam("gitlab_delete_label", "label_name", args.label_name, undefined);
    enforceAnyLockedProject("gitlab_delete_label", projectId);
    await gitlab.deleteLabel(projectId, labelName);
    return {
      deleted: true,
      label_name: labelName,
      project_id: projectId,
    };
  }),
);

server.registerTool(
  "gitlab_create_issue",
  {
    description: "Create an issue with GitLab REST API /projects/:id/issues.",
    outputSchema: gitlabCreateIssueOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      title: z.string().optional().describe("Issue title."),
      description: z.string().optional().describe("Issue description markdown."),
      labels: z.array(z.string()).optional().describe("Issue labels array."),
      assignee_ids: z.array(z.number().int().positive()).optional().describe("Assignee user IDs."),
      assignee_usernames: z
        .array(z.string())
        .optional()
        .describe("Optional assignee GitLab usernames. Resolved to assignee_ids internally."),
      assign_to_current_user_if_missing: z
        .boolean()
        .optional()
        .describe("When true, assign issue to current token user if no assignee is provided."),
      milestone_id: z.number().int().positive().optional().describe("Milestone ID."),
      due_date: z.string().optional().describe("Due date in YYYY-MM-DD."),
      confidential: z.boolean().optional().describe("Whether issue is confidential."),
      issue_type: z.string().optional().describe("GitLab issue_type value."),
    },
  },
  withToolErrorHandling("gitlab_create_issue", async (args) => {
    const projectId = requireNumberParam("gitlab_create_issue", "project_id", args.project_id, undefined);
    enforceIssueProjectLock("gitlab_create_issue", projectId);
    const title = requireStringParam("gitlab_create_issue", "title", args.title, undefined);
    const dueDate = ensureIsoDate("gitlab_create_issue", "due_date", args.due_date);
    const assigneeIds = await resolveIssueAssigneeIds("gitlab_create_issue", {
      assigneeIds: args.assignee_ids,
      assigneeUsernames: args.assignee_usernames,
      assignToCurrentUserIfMissing: args.assign_to_current_user_if_missing ?? true,
    });

    const issue = await gitlab.createIssue({
      projectId,
      title,
      description: args.description,
      labels: normalizeStringArray(args.labels),
      assigneeIds,
      milestoneId: args.milestone_id,
      dueDate,
      confidential: args.confidential,
      issueType: args.issue_type,
    });
    return issue;
  }),
);

server.registerTool(
  "gitlab_get_merge_request",
  {
    description: "Get merge request detail (/projects/:id/merge_requests/:mr_iid).",
    outputSchema: gitlabGetMergeRequestOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
    },
  },
  withToolErrorHandling("gitlab_get_merge_request", async (args) => {
    const projectId = requireNumberParam("gitlab_get_merge_request", "project_id", args.project_id, undefined);
    const mrIid = requireNumberParam("gitlab_get_merge_request", "mr_iid", args.mr_iid, undefined);
    enforceCodeProjectLock("gitlab_get_merge_request", projectId);
    return gitlab.getMergeRequest(projectId, mrIid);
  }),
);

server.registerTool(
  "gitlab_get_mr_notes",
  {
    description: "Get merge request notes/comments (/projects/:id/merge_requests/:mr_iid/notes).",
    outputSchema: gitlabGetMrNotesOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
      sort: z.enum(["asc", "desc"]).optional().describe("Sort order."),
      order_by: z
        .enum(["created_at", "updated_at"])
        .optional()
        .describe("Field used for ordering."),
    },
  },
  withToolErrorHandling("gitlab_get_mr_notes", async (args) => {
    const projectId = requireNumberParam("gitlab_get_mr_notes", "project_id", args.project_id, undefined);
    const mrIid = requireNumberParam("gitlab_get_mr_notes", "mr_iid", args.mr_iid, undefined);
    enforceCodeProjectLock("gitlab_get_mr_notes", projectId);
    return gitlab.getMergeRequestNotes(projectId, mrIid, {
      sort: args.sort,
      orderBy: args.order_by,
    });
  }),
);

server.registerTool(
  "gitlab_get_issue",
  {
    description: "Get one issue by project_id + issue_iid.",
    outputSchema: gitlabGetIssueOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      issue_iid: z.number().int().positive().optional().describe("Issue IID (internal ID)."),
    },
  },
  withToolErrorHandling("gitlab_get_issue", async (args) => {
    const projectId = requireNumberParam("gitlab_get_issue", "project_id", args.project_id, undefined);
    const issueIid = requireNumberParam("gitlab_get_issue", "issue_iid", args.issue_iid, undefined);
    enforceIssueProjectLock("gitlab_get_issue", projectId);
    return gitlab.getIssue(projectId, issueIid);
  }),
);

server.registerTool(
  "gitlab_upload_project_file",
  {
    description:
      "Upload binary file to project markdown uploads and return markdown/url metadata.",
    outputSchema: gitlabUploadProjectFileOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      filename: z.string().optional().describe("Original file name."),
      content_base64: z.string().optional().describe("File content encoded in base64."),
      content_type: z
        .string()
        .optional()
        .describe("Optional MIME type, e.g. image/png."),
    },
  },
  withToolErrorHandling("gitlab_upload_project_file", async (args) => {
    const projectId = requireNumberParam(
      "gitlab_upload_project_file",
      "project_id",
      args.project_id,
      undefined,
    );
    const filename = requireStringParam("gitlab_upload_project_file", "filename", args.filename, undefined);
    const contentBase64 = requireStringParam(
      "gitlab_upload_project_file",
      "content_base64",
      args.content_base64,
      undefined,
    );
    enforceAnyLockedProject("gitlab_upload_project_file", projectId);
    return gitlab.uploadProjectFile({
      projectId,
      filename,
      contentBase64,
      contentType: args.content_type?.trim(),
    });
  }),
);

server.registerTool(
  "gitlab_get_issue_images",
  {
    description:
      "Extract image references from issue description/notes, optionally downloading image base64 payloads.",
    outputSchema: gitlabGetIssueImagesOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      issue_iid: z.number().int().positive().optional().describe("Issue IID."),
      include_notes: z
        .boolean()
        .optional()
        .describe("Whether to extract images from issue notes as well."),
      include_base64: z
        .boolean()
        .optional()
        .describe("Whether to download every extracted image and include base64."),
      max_images: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of image references to return."),
    },
  },
  withToolErrorHandling("gitlab_get_issue_images", async (args) => {
    const projectId = requireNumberParam("gitlab_get_issue_images", "project_id", args.project_id, undefined);
    const issueIid = requireNumberParam("gitlab_get_issue_images", "issue_iid", args.issue_iid, undefined);
    const includeNotes = args.include_notes ?? true;
    const includeBase64 = args.include_base64 ?? false;
    const maxImages = ensurePositiveIntRangeOptional(
      "gitlab_get_issue_images",
      "max_images",
      args.max_images,
      200,
    ) ?? 50;

    enforceIssueProjectLock("gitlab_get_issue_images", projectId);

    const issue = await gitlab.getIssue(projectId, issueIid);
    const imageRows: Array<Record<string, unknown>> = [];

    const issueDescription = typeof issue.description === "string" ? issue.description : "";
    for (const imageRef of extractImageReferences(issueDescription)) {
      imageRows.push({
        source: "issue_description",
        alt_text: imageRef.altText,
        raw_url: imageRef.rawUrl,
        resolved_url: gitlab.resolveWebUrl(imageRef.rawUrl),
        markdown_fragment: imageRef.markdownFragment,
      });
    }

    if (includeNotes) {
      const notes = await gitlab.getIssueNotes(projectId, issueIid, {
        sort: "asc",
        orderBy: "created_at",
      });
      for (const note of notes as any[]) {
        const body = typeof note?.body === "string" ? note.body : "";
        const imageRefs = extractImageReferences(body);
        for (const imageRef of imageRefs) {
          imageRows.push({
            source: "issue_note",
            note_id: Number.isInteger(note?.id) ? note.id : undefined,
            note_created_at:
              typeof note?.created_at === "string" ? note.created_at : undefined,
            alt_text: imageRef.altText,
            raw_url: imageRef.rawUrl,
            resolved_url: gitlab.resolveWebUrl(imageRef.rawUrl),
            markdown_fragment: imageRef.markdownFragment,
          });
        }
      }
    }

    const dedupedRows = Array.from(
      new Map(
        imageRows.map((item) => [
          `${item.source}|${item.note_id ?? 0}|${item.raw_url}|${item.markdown_fragment}`,
          item,
        ]),
      ).values(),
    ).slice(0, maxImages);

    if (includeBase64) {
      for (const imageRow of dedupedRows) {
        const rawUrl = imageRow.raw_url;
        if (typeof rawUrl !== "string") {
          continue;
        }
        try {
          const download = await gitlab.downloadBinaryAsBase64(rawUrl);
          imageRow.content_type = download.content_type;
          imageRow.size_bytes = download.size_bytes;
          imageRow.base64 = download.base64;
          imageRow.resolved_url = download.resolved_url;
        } catch (error) {
          imageRow.fetch_error =
            error instanceof Error ? error.message : String(error);
        }
      }
    }

    return {
      issue_iid: issueIid,
      issue_web_url: typeof issue.web_url === "string" ? issue.web_url : undefined,
      image_count: dedupedRows.length,
      images: dedupedRows,
    };
  }),
);

server.registerTool(
  "gitlab_get_issue_notes",
  {
    description: "Get issue notes/comments by project_id + issue_iid.",
    outputSchema: gitlabGetIssueNotesOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      issue_iid: z.number().int().positive().optional().describe("Issue IID (internal ID)."),
      sort: z.enum(["asc", "desc"]).optional().describe("Sort order."),
      order_by: z
        .enum(["created_at", "updated_at"])
        .optional()
        .describe("Field used for ordering."),
    },
  },
  withToolErrorHandling("gitlab_get_issue_notes", async (args) => {
    const projectId = requireNumberParam("gitlab_get_issue_notes", "project_id", args.project_id, undefined);
    const issueIid = requireNumberParam("gitlab_get_issue_notes", "issue_iid", args.issue_iid, undefined);
    enforceIssueProjectLock("gitlab_get_issue_notes", projectId);
    return gitlab.getIssueNotes(projectId, issueIid, {
      sort: args.sort,
      orderBy: args.order_by,
    });
  }),
);

server.registerTool(
  "gitlab_add_issue_comment",
  {
    description: "Create issue note/comment by GitLab REST API.",
    outputSchema: gitlabAddIssueCommentOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      issue_iid: z.number().int().positive().optional().describe("Issue IID."),
      body: z.string().optional().describe("Comment markdown body."),
    },
  },
  withToolErrorHandling("gitlab_add_issue_comment", async (args) => {
    const projectId = requireNumberParam("gitlab_add_issue_comment", "project_id", args.project_id, undefined);
    const issueIid = requireNumberParam("gitlab_add_issue_comment", "issue_iid", args.issue_iid, undefined);
    const body = requireStringParam("gitlab_add_issue_comment", "body", args.body, undefined);
    enforceIssueProjectLock("gitlab_add_issue_comment", projectId);
    return gitlab.createIssueNote(projectId, issueIid, body);
  }),
);

server.registerTool(
  "gitlab_create_branch",
  {
    description: "Create repository branch by GitLab REST API.",
    outputSchema: gitlabCreateBranchOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      branch: z.string().optional().describe("Branch name to create."),
      ref: z.string().optional().describe("Source ref (branch/tag/SHA)."),
    },
  },
  withToolErrorHandling("gitlab_create_branch", async (args) => {
    const projectId = requireNumberParam("gitlab_create_branch", "project_id", args.project_id, undefined);
    const branch = requireStringParam("gitlab_create_branch", "branch", args.branch, undefined);
    const ref = requireStringParam("gitlab_create_branch", "ref", args.ref, undefined);
    enforceCodeProjectLock("gitlab_create_branch", projectId);
    return gitlab.createBranch(projectId, branch, ref);
  }),
);

server.registerTool(
  "gitlab_get_file",
  {
    description: "Get repository file by GitLab REST API /repository/files/:file_path.",
    outputSchema: gitlabGetFileOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      file_path: z.string().optional().describe("Repository file path."),
      ref: z
        .string()
        .optional()
        .describe("Branch/tag/SHA to read. Optional; when omitted GitLab HEAD is used."),
    },
  },
  withToolErrorHandling("gitlab_get_file", async (args) => {
    const projectId = requireNumberParam("gitlab_get_file", "project_id", args.project_id, undefined);
    const filePath = requireStringParam("gitlab_get_file", "file_path", args.file_path, undefined);
    enforceCodeProjectLock("gitlab_get_file", projectId);
    return gitlab.getFile(projectId, filePath, args.ref);
  }),
);

server.registerTool(
  "gitlab_commit_files",
  {
    description: "Create one commit with multiple file actions via GitLab commits API.",
    outputSchema: gitlabCommitFilesOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      branch: z.string().optional().describe("Target branch."),
      commit_message: z.string().optional().describe("Commit message."),
      start_branch: z
        .string()
        .optional()
        .describe("Optional source branch when committing to a new branch."),
      actions: z.array(commitActionSchema).optional().describe("Commit actions list."),
    },
  },
  withToolErrorHandling("gitlab_commit_files", async (args) => {
    const projectId = requireNumberParam("gitlab_commit_files", "project_id", args.project_id, undefined);
    const branch = requireStringParam("gitlab_commit_files", "branch", args.branch, undefined);
    const commitMessage = requireStringParam(
      "gitlab_commit_files",
      "commit_message",
      args.commit_message,
      undefined,
    );
    if (!args.actions) {
      missingParam("gitlab_commit_files", "actions");
    }

    const actions: CommitActionInput[] = args.actions.map((action) => ({
      action: action.action,
      file_path: action.file_path?.trim(),
      previous_path: action.previous_path?.trim(),
      content: action.content,
      encoding: action.encoding,
      execute_filemode: action.execute_filemode,
      last_commit_id: action.last_commit_id?.trim(),
    }));
    validateCommitActions("gitlab_commit_files", actions);
    enforceCodeProjectLock("gitlab_commit_files", projectId);

    return gitlab.createCommit({
      projectId,
      branch,
      commitMessage,
      actions,
      startBranch: args.start_branch?.trim(),
    });
  }),
);

server.registerTool(
  "gitlab_create_merge_request",
  {
    description: "Create merge request by GitLab REST API /projects/:id/merge_requests.",
    outputSchema: gitlabCreateMergeRequestOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      source_branch: z.string().optional().describe("Source branch."),
      target_branch: z.string().optional().describe("Target branch."),
      title: z.string().optional().describe("Merge request title."),
      description: z.string().optional().describe("Merge request description."),
      labels: z.array(z.string()).optional().describe("Labels array."),
      assignee_ids: z.array(z.number().int().positive()).optional().describe("Assignee user IDs."),
      reviewer_ids: z.array(z.number().int().positive()).optional().describe("Reviewer user IDs."),
      remove_source_branch: z.boolean().optional().describe("Remove source branch after merge."),
      squash: z.boolean().optional().describe("Enable squash on merge."),
      draft: z.boolean().optional().describe("Create MR as draft."),
    },
  },
  withToolErrorHandling("gitlab_create_merge_request", async (args) => {
    const projectId = requireNumberParam(
      "gitlab_create_merge_request",
      "project_id",
      args.project_id,
      undefined,
    );
    const sourceBranch = requireStringParam(
      "gitlab_create_merge_request",
      "source_branch",
      args.source_branch,
      undefined,
    );
    const targetBranch = requireStringParam(
      "gitlab_create_merge_request",
      "target_branch",
      args.target_branch,
      undefined,
    );
    const title = requireStringParam("gitlab_create_merge_request", "title", args.title, undefined);
    enforceCodeProjectLock("gitlab_create_merge_request", projectId);
    return gitlab.createMergeRequest({
      projectId,
      sourceBranch,
      targetBranch,
      title,
      description: args.description,
      labels: normalizeStringArray(args.labels),
      assigneeIds: normalizePositiveIntArray(
        "gitlab_create_merge_request",
        "assignee_ids",
        args.assignee_ids,
      ),
      reviewerIds: normalizePositiveIntArray(
        "gitlab_create_merge_request",
        "reviewer_ids",
        args.reviewer_ids,
      ),
      removeSourceBranch: args.remove_source_branch,
      squash: args.squash,
      draft: args.draft,
    });
  }),
);

server.registerTool(
  "gitlab_create_mr_note",
  {
    description: "Create merge-request note/comment.",
    outputSchema: gitlabCreateMrNoteOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
      body: z.string().optional().describe("Comment markdown body."),
    },
  },
  withToolErrorHandling("gitlab_create_mr_note", async (args) => {
    const projectId = requireNumberParam("gitlab_create_mr_note", "project_id", args.project_id, undefined);
    const mrIid = requireNumberParam("gitlab_create_mr_note", "mr_iid", args.mr_iid, undefined);
    const body = requireStringParam("gitlab_create_mr_note", "body", args.body, undefined);
    enforceCodeProjectLock("gitlab_create_mr_note", projectId);
    return gitlab.createMergeRequestNote(projectId, mrIid, body);
  }),
);

server.registerTool(
  "gitlab_get_mr_changes",
  {
    description: "Get merge request changes/diff metadata.",
    outputSchema: gitlabGetMrChangesOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
    },
  },
  withToolErrorHandling("gitlab_get_mr_changes", async (args) => {
    const projectId = requireNumberParam("gitlab_get_mr_changes", "project_id", args.project_id, undefined);
    const mrIid = requireNumberParam("gitlab_get_mr_changes", "mr_iid", args.mr_iid, undefined);
    enforceCodeProjectLock("gitlab_get_mr_changes", projectId);
    return gitlab.getMergeRequestChanges(projectId, mrIid);
  }),
);

server.registerTool(
  "gitlab_approve_mr",
  {
    description: "Approve merge request by GitLab approval API.",
    outputSchema: gitlabApproveMrOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
      sha: z
        .string()
        .optional()
        .describe("Optional expected HEAD SHA for optimistic locking during approval."),
    },
  },
  withToolErrorHandling("gitlab_approve_mr", async (args) => {
    const projectId = requireNumberParam("gitlab_approve_mr", "project_id", args.project_id, undefined);
    const mrIid = requireNumberParam("gitlab_approve_mr", "mr_iid", args.mr_iid, undefined);
    enforceCodeProjectLock("gitlab_approve_mr", projectId);
    return gitlab.approveMergeRequest(projectId, mrIid, args.sha?.trim());
  }),
);

server.registerTool(
  "gitlab_unapprove_mr",
  {
    description: "Remove approval from merge request.",
    outputSchema: gitlabUnapproveMrOutputSchema,
    inputSchema: {
      project_id: z.number().int().positive().optional().describe("GitLab project ID."),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
    },
  },
  withToolErrorHandling("gitlab_unapprove_mr", async (args) => {
    const projectId = requireNumberParam("gitlab_unapprove_mr", "project_id", args.project_id, undefined);
    const mrIid = requireNumberParam("gitlab_unapprove_mr", "mr_iid", args.mr_iid, undefined);
    enforceCodeProjectLock("gitlab_unapprove_mr", projectId);
    return gitlab.unapproveMergeRequest(projectId, mrIid);
  }),
);

// TOOL REGISTRATION END

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
