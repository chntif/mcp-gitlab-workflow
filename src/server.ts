#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getRuntimeConfig } from "./config.js";
import { DELIVERY_METHOD_VALUES, normalizeDeliveryMethod, type DeliveryMethod } from "./delivery-mode.js";
import {
  deleteDeliveryPreparationRecord,
  getDeliveryPreparationRecord,
  getDeliveryPreparationStatePath,
  saveDeliveryPreparationRecord,
  type DeliveryPreparationRecord,
} from "./delivery-preparation.js";
import { CommitActionInput, GitLabClient } from "./gitlab.js";
import { appendIssueLogMarkdown, resolveRepoScopedPath } from "./issue-log.js";
import {
  LocalGitError,
  commitAndPushLocalBranch,
  ensureCleanWorktree,
  getCurrentBranchName,
  getHeadSha,
  prepareLocalWorkingBranch,
  runGitInRepo,
} from "./local-delivery.js";
import {
  WorkType,
  buildBranchName,
  buildDefaultIssueDescription,
  buildIssueTitle,
  detectWorkType,
  isValidWorkType,
  normalizeWorkType,
  renderIssueCompletionComment,
  renderIssueLogEntry,
  renderMergeRequestDescription,
  renderTemplate,
  summarizeRequirement,
} from "./workflow.js";
import { buildPreparedMrReviewContext } from "./review.js";
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
  workflowAnalyzeAndCreateIssueOutputSchema,
  workflowAppendIssueLogOutputSchema,
  workflowIssueToMrFullOutputSchema,
  workflowLocalSyncCheckoutBranchOutputSchema,
  workflowPrepareDeliveryWorkspaceOutputSchema,
  workflowRequirementToDeliveryFullOutputSchema,
  workflowReviewMrAndCommentOutputSchema,
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

type ToolImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

function contentResult(
  data: Record<string, unknown>,
  extraContent: ToolImageContent[] = [],
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
      ...extraContent,
    ],
    structuredContent: data,
  };
}

function envBackedDescription(description: string, envVarName: string, extra?: string): string {
  const suffix =
    ` Omit this field unless the user explicitly provided a value. ` +
    `When omitted, the current runtime config value is used (${envVarName} overrides the built-in default when configured). ` +
    `If the runtime config is still unset, the tool returns a missing-parameter error. ` +
    `Do not infer or auto-generate this value.`;
  return extra ? `${description}${suffix} ${extra}` : `${description}${suffix}`;
}

function anyProjectEnvBackedDescription(description: string, extra?: string): string {
  const suffix =
    ` Omit this field unless the user explicitly provided a value. ` +
    `When omitted, the tool tries the current runtime config defaults from WORKFLOW_ISSUE_PROJECT_ID or WORKFLOW_CODE_PROJECT_ID. ` +
    `If both are unset, or both are set to different values, the tool returns a missing-parameter error and you must pass project_id explicitly. ` +
    `Do not infer or auto-generate this value.`;
  return extra ? `${description}${suffix} ${extra}` : `${description}${suffix}`;
}

const workTypeSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9._-]*$/,
    "Use a lowercase git/conventional prefix like feat, fix, docs, refactor, hotfix, feature.",
  );

const deliveryMethodSchema = z
  .enum(DELIVERY_METHOD_VALUES)
  .describe("Delivery implementation mode. Use 'local_git' or 'remote_api'.");


function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function getLabelStrippedSummary(issueTitle: string): string {
  return issueTitle.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function inferWorkTypeFromBranch(branchName: string): WorkType {
  const prefix = branchName.split("/")[0]?.trim().toLowerCase() ?? "";
  if (prefix && isValidWorkType(prefix)) {
    return prefix;
  }
  return "feat";
}

function parseRequirementMetadata(params: {
  requirementText: string;
  englishSlug?: string;
  workType?: WorkType;
  summary?: string;
  label?: string;
}) {
  const parsedWorkType = params.workType
    ? normalizeWorkType(params.workType)
    : detectWorkType(params.requirementText);
  const issueSummary = params.summary ?? summarizeRequirement(params.requirementText, 30);
  const issueTitle = buildIssueTitle(issueSummary, params.label);
  const branchName = buildBranchName({
    workType: parsedWorkType,
    englishSlug: params.englishSlug,
    requirementText: params.requirementText,
  });
  return {
    workType: parsedWorkType,
    summary: issueSummary,
    issueTitle,
    branchName,
  };
}

function resolvePrepareWorkingBranch(params: {
  toolName: string;
  deliveryMethod: DeliveryMethod;
  branchName?: string;
  englishSlug?: string;
  workType?: WorkType;
  summary?: string;
  requirementText?: string;
}): string | undefined {
  if (params.deliveryMethod !== "local_git") {
    return undefined;
  }

  const explicitBranchName = params.branchName?.trim();
  if (explicitBranchName) {
    return explicitBranchName;
  }

  const requirementSeed = params.requirementText?.trim() || params.summary?.trim();
  if (!requirementSeed) {
    missingParam(params.toolName, "branch_name");
  }

  return buildBranchName({
    workType: params.workType
      ? normalizeWorkType(params.workType)
      : detectWorkType(requirementSeed),
    englishSlug: params.englishSlug,
    requirementText: requirementSeed,
  });
}

function buildIssueDescriptionFromInput(params: {
  toolName: string;
  issueTemplate?: string;
  templateVariables?: Record<string, string>;
  requirementText: string;
  summary: string;
  sourceText?: string;
  issueProjectId: number;
  issueProjectPath?: string;
  codeProjectId?: number;
  codeProjectPath?: string;
  branchName: string;
  workType: WorkType;
  label?: string;
}): string {
  if (params.issueTemplate) {
    const variables = {
      requirement_text: params.requirementText,
      summary: params.summary,
      source_text: params.sourceText ?? params.requirementText,
      expected_change: params.requirementText,
      issue_project_id: String(params.issueProjectId),
      code_project_id: String(params.codeProjectId ?? ""),
      issue_project_path: params.issueProjectPath ?? "",
      code_project_path: params.codeProjectPath ?? "",
      branch_name: params.branchName,
      work_type: params.workType,
      label: params.label ?? "",
    };
    return renderTemplate(params.issueTemplate, {
      ...variables,
      ...(params.templateVariables ?? {}),
    });
  }

  return buildDefaultIssueDescription({
    summary: params.summary,
    requirementText: params.requirementText,
    sourceText: params.sourceText ?? params.requirementText,
    repoPath: params.codeProjectPath,
    branchName: params.branchName,
  });
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

function requireIssueProjectIdParam(
  toolName: string,
  fieldName: string,
  valueFromArgs: number | undefined,
): number {
  return requireNumberParam(
    toolName,
    fieldName,
    valueFromArgs,
    config.defaults.issueProjectId,
    "WORKFLOW_ISSUE_PROJECT_ID",
  );
}

function requireCodeProjectIdParam(
  toolName: string,
  fieldName: string,
  valueFromArgs: number | undefined,
): number {
  return requireNumberParam(
    toolName,
    fieldName,
    valueFromArgs,
    config.defaults.codeProjectId,
    "WORKFLOW_CODE_PROJECT_ID",
  );
}

function requireAnyProjectIdParam(
  toolName: string,
  fieldName: string,
  valueFromArgs: number | undefined,
): number {
  if (valueFromArgs !== undefined) {
    return requireNumberParam(toolName, fieldName, valueFromArgs, undefined);
  }

  const issueProjectId = config.defaults.issueProjectId;
  const codeProjectId = config.defaults.codeProjectId;
  if (
    issueProjectId !== undefined &&
    codeProjectId !== undefined &&
    issueProjectId !== codeProjectId
  ) {
    throw new ToolInputError(
      `[${toolName}] Missing required parameter '${fieldName}'. Runtime config is ambiguous because WORKFLOW_ISSUE_PROJECT_ID=${issueProjectId} and WORKFLOW_CODE_PROJECT_ID=${codeProjectId}. Provide '${fieldName}' explicitly.`,
    );
  }

  return requireNumberParam(
    toolName,
    fieldName,
    undefined,
    issueProjectId ?? codeProjectId,
    "WORKFLOW_ISSUE_PROJECT_ID/WORKFLOW_CODE_PROJECT_ID",
  );
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
  if (error instanceof ToolInputError || error instanceof LocalGitError) {
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

async function updateIssueLogWithMr(params: {
  repoPath: string;
  logPath: string;
  issueIid: number;
  mrIid: number;
  mrUrl: string;
  status: string;
}): Promise<string> {
  const absolutePath = resolveRepoScopedPath(params.repoPath, params.logPath);
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

async function issueContainsImageReferences(projectId: number, issueIid: number): Promise<boolean> {
  const issue = await gitlab.getIssue(projectId, issueIid);
  const issueDescription = typeof issue.description === "string" ? issue.description : "";
  if (extractImageReferences(issueDescription).length > 0) {
    return true;
  }

  const notes = await gitlab.getIssueNotes(projectId, issueIid, {
    sort: "asc",
    orderBy: "created_at",
  });
  for (const note of notes as any[]) {
    const body = typeof note?.body === "string" ? note.body : "";
    if (extractImageReferences(body).length > 0) {
      return true;
    }
  }

  return false;
}

const DEFAULT_LABEL_COLOR_MAP: Record<string, string> = {
  前端: "#1D76DB",
  后端: "#0E8A16",
  BUG: "#D73A4A",
  UI: "#FBCA04",
};

function pickLabelColor(label: string): string {
  return DEFAULT_LABEL_COLOR_MAP[label] ?? "#428BCA";
}

function detectSuggestedLabels(requirementText: string, workType: WorkType): string[] {
  const normalized = requirementText.toLowerCase();
  const labels: string[] = [];
  if (normalized.includes("ui") || normalized.includes("样式") || normalized.includes("界面")) {
    labels.push("UI");
  }
  if (
    normalized.includes("front") ||
    normalized.includes("frontend") ||
    normalized.includes("前端")
  ) {
    labels.push("前端");
  }
  if (
    normalized.includes("back") ||
    normalized.includes("backend") ||
    normalized.includes("后端") ||
    normalized.includes("api")
  ) {
    labels.push("后端");
  }
  if (workType === "fix" || normalized.includes("bug") || normalized.includes("错误")) {
    labels.push("BUG");
  }
  if (labels.length === 0) {
    labels.push("前端");
  }
  return [...new Set(labels)];
}

async function ensureLabelsExist(
  toolName: string,
  projectId: number,
  labels: string[],
  autoCreate: boolean,
): Promise<string[]> {
  const normalized = normalizeUniqueStringArray(labels) ?? [];
  if (normalized.length === 0) {
    return [];
  }
  if (!autoCreate) {
    return normalized;
  }

  const existingLabels = await gitlab.listLabels(projectId, {
    page: 1,
    perPage: 100,
  });
  const existingNames = new Set(
    (existingLabels as any[])
      .map((item) => (typeof item?.name === "string" ? item.name.trim().toLowerCase() : ""))
      .filter((name) => name.length > 0),
  );

  for (const label of normalized) {
    if (existingNames.has(label.toLowerCase())) {
      continue;
    }
    try {
      await gitlab.createLabel({
        projectId,
        name: label,
        color: pickLabelColor(label),
      });
      existingNames.add(label.toLowerCase());
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) {
        continue;
      }
      throw new ToolInputError(
        `[${toolName}] Failed to auto-create label '${label}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return normalized;
}

async function prepareDeliveryWorkspace(params: {
  toolName: string;
  repoPath: string;
  remoteName: string;
  baseBranch: string;
  deliveryMethod: DeliveryMethod;
  workingBranch?: string;
}): Promise<{
  repo_path: string;
  remote_name: string;
  delivery_method: DeliveryMethod;
  base_branch: string;
  working_branch?: string;
  current_branch: string;
  base_head_sha: string;
  commands: string[];
  preparation_key: string;
  prepared_at: string;
  expires_at: string;
}> {
  let prepared: {
    repo_path: string;
    remote_name: string;
    base_branch: string;
    current_branch: string;
    base_head_sha: string;
    commands: string[];
    working_branch?: string;
  };

  if (params.deliveryMethod === "local_git") {
    const workingBranch = params.workingBranch?.trim();
    if (!workingBranch) {
      missingParam(params.toolName, "branch_name");
    }
    prepared = await prepareLocalWorkingBranch({
      toolName: params.toolName,
      repoPath: params.repoPath,
      remoteName: params.remoteName,
      baseBranch: params.baseBranch,
      workingBranch,
    });
  } else {
    await ensureCleanWorktree(params.toolName, params.repoPath);

    const commands: string[] = [];
    const pushCommand = (args: string[]) => {
      commands.push(`git -C ${params.repoPath} ${args.join(" ")}`);
    };

    const fetchArgs = ["fetch", params.remoteName, params.baseBranch];
    pushCommand(fetchArgs);
    await runGitInRepo(params.toolName, params.repoPath, fetchArgs);

    const checkoutArgs = ["checkout", params.baseBranch];
    pushCommand(checkoutArgs);
    await runGitInRepo(params.toolName, params.repoPath, checkoutArgs);

    const pullArgs = ["pull", params.remoteName, params.baseBranch];
    pushCommand(pullArgs);
    await runGitInRepo(params.toolName, params.repoPath, pullArgs);

    await ensureCleanWorktree(params.toolName, params.repoPath);

    const currentBranch = await getCurrentBranchName(params.toolName, params.repoPath);
    if (currentBranch.trim() !== params.baseBranch) {
      throw new ToolInputError(
        `[${params.toolName}] Expected current branch '${params.baseBranch}' after preparation, got '${currentBranch.trim()}'.`,
      );
    }

    const baseHeadSha = await getHeadSha(params.toolName, params.repoPath);
    prepared = {
      repo_path: params.repoPath,
      remote_name: params.remoteName,
      base_branch: params.baseBranch,
      current_branch: currentBranch,
      base_head_sha: baseHeadSha,
      commands,
    };
  }

  const statePath = getDeliveryPreparationStatePath();
  const record = await saveDeliveryPreparationRecord(statePath, {
    repoPath: params.repoPath,
    remoteName: params.remoteName,
    baseBranch: params.baseBranch,
    baseHeadSha: prepared.base_head_sha,
    deliveryMethod: params.deliveryMethod,
    workingBranch: prepared.working_branch,
  });

  return {
    ...prepared,
    delivery_method: params.deliveryMethod,
    working_branch: prepared.working_branch,
    preparation_key: record.preparationKey,
    prepared_at: record.preparedAt,
    expires_at: record.expiresAt,
  };
}

async function requireDeliveryPreparation(params: {
  toolName: string;
  preparationKey: string;
}): Promise<DeliveryPreparationRecord> {
  const record = await getDeliveryPreparationRecord(
    getDeliveryPreparationStatePath(),
    params.preparationKey.trim(),
  );
  if (!record) {
    throw new ToolInputError(
      `[${params.toolName}] Invalid or expired preparation_key. Run workflow_prepare_delivery_workspace again before generating commit_actions.`,
    );
  }

  const currentBranch = await getCurrentBranchName(params.toolName, record.repoPath);
  if (record.deliveryMethod === "local_git") {
    if (!record.workingBranch) {
      throw new ToolInputError(
        `[${params.toolName}] preparation_key is missing working_branch for delivery_method=local_git. Re-run workflow_prepare_delivery_workspace.`,
      );
    }
    if (currentBranch.trim() !== record.workingBranch) {
      throw new ToolInputError(
        `[${params.toolName}] preparation_key is no longer valid because local branch is '${currentBranch.trim()}', expected '${record.workingBranch}'. Re-run workflow_prepare_delivery_workspace.`,
      );
    }
  } else {
    await ensureCleanWorktree(params.toolName, record.repoPath);
    if (currentBranch.trim() !== record.baseBranch) {
      throw new ToolInputError(
        `[${params.toolName}] preparation_key is no longer valid because local branch is '${currentBranch.trim()}', expected '${record.baseBranch}'. Re-run workflow_prepare_delivery_workspace.`,
      );
    }

    const localHeadSha = await getHeadSha(params.toolName, record.repoPath);
    if (localHeadSha.trim() !== record.baseHeadSha) {
      throw new ToolInputError(
        `[${params.toolName}] preparation_key is no longer valid because local HEAD changed from '${record.baseHeadSha}' to '${localHeadSha.trim()}'. Re-run workflow_prepare_delivery_workspace.`,
      );
    }
  }

  await runGitInRepo(params.toolName, record.repoPath, ["fetch", record.remoteName, record.baseBranch]);
  const remoteHeadSha = await getHeadSha(
    params.toolName,
    record.repoPath,
    `${record.remoteName}/${record.baseBranch}`,
  );
  if (remoteHeadSha.trim() !== record.baseHeadSha) {
    throw new ToolInputError(
      `[${params.toolName}] preparation_key is stale because ${record.remoteName}/${record.baseBranch} advanced from '${record.baseHeadSha}' to '${remoteHeadSha.trim()}'. Re-run workflow_prepare_delivery_workspace and regenerate commit_actions.`,
    );
  }

  return record;
}

async function syncAndCheckoutLocalBranch(params: {
  toolName: string;
  repoPath: string;
  remoteName: string;
  branchName: string;
  baseBranch?: string;
}): Promise<{
  repo_path: string;
  remote_name: string;
  branch_name: string;
  commands: string[];
  current_branch: string;
  head_sha: string;
}> {
  const commands: string[] = [];
  const pushCommand = (args: string[]) => {
    commands.push(`git -C ${params.repoPath} ${args.join(" ")}`);
  };

  await ensureCleanWorktree(params.toolName, params.repoPath);

  const fetchArgs = ["fetch", params.remoteName];
  pushCommand(fetchArgs);
  await runGitInRepo(params.toolName, params.repoPath, fetchArgs);

  if (params.baseBranch?.trim()) {
    const checkoutBaseArgs = ["checkout", params.baseBranch];
    pushCommand(checkoutBaseArgs);
    await runGitInRepo(params.toolName, params.repoPath, checkoutBaseArgs);

    const pullBaseArgs = ["pull", params.remoteName, params.baseBranch];
    pushCommand(pullBaseArgs);
    await runGitInRepo(params.toolName, params.repoPath, pullBaseArgs);
  }

  const localBranch = await runGitInRepo(params.toolName, params.repoPath, [
    "branch",
    "--list",
    params.branchName,
  ]);
  const remoteBranch = await runGitInRepo(params.toolName, params.repoPath, [
    "branch",
    "-r",
    "--list",
    `${params.remoteName}/${params.branchName}`,
  ]);

  if (localBranch.trim()) {
    const checkoutLocalArgs = ["checkout", params.branchName];
    pushCommand(checkoutLocalArgs);
    await runGitInRepo(params.toolName, params.repoPath, checkoutLocalArgs);

    if (remoteBranch.trim()) {
      const pullLocalArgs = ["pull", params.remoteName, params.branchName];
      pushCommand(pullLocalArgs);
      await runGitInRepo(params.toolName, params.repoPath, pullLocalArgs);
    }
  } else if (remoteBranch.trim()) {
    const checkoutTrackArgs = [
      "checkout",
      "-b",
      params.branchName,
      "--track",
      `${params.remoteName}/${params.branchName}`,
    ];
    pushCommand(checkoutTrackArgs);
    await runGitInRepo(params.toolName, params.repoPath, checkoutTrackArgs);
  } else {
    const checkoutNewArgs = ["checkout", "-b", params.branchName];
    pushCommand(checkoutNewArgs);
    await runGitInRepo(params.toolName, params.repoPath, checkoutNewArgs);
  }

  const currentBranch = await runGitInRepo(params.toolName, params.repoPath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const headSha = await runGitInRepo(params.toolName, params.repoPath, ["rev-parse", "HEAD"]);

  return {
    repo_path: params.repoPath,
    remote_name: params.remoteName,
    branch_name: params.branchName,
    commands,
    current_branch: currentBranch,
    head_sha: headSha,
  };
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
  const workType = params.workType
    ? normalizeWorkType(params.workType)
    : inferWorkTypeFromBranch(params.sourceBranch);
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

function buildIssueReferenceText(params: {
  issueIid: number;
  issueProjectId?: number;
  issueProjectPath?: string;
}): string {
  const issueProjectPath = params.issueProjectPath?.trim();
  if (issueProjectPath) {
    return `${issueProjectPath}#${params.issueIid}`;
  }
  if (params.issueProjectId !== undefined) {
    return `project_id=${params.issueProjectId}, issue_iid=${params.issueIid}`;
  }
  return `issue_iid=${params.issueIid}`;
}

function withIssueReferenceInMrDescription(params: {
  description?: string;
  issueIid?: number;
  issueProjectId?: number;
  issueProjectPath?: string;
}): string | undefined {
  const description = params.description?.trim();
  if (params.issueIid === undefined) {
    return description || undefined;
  }

  const issueRef = buildIssueReferenceText({
    issueIid: params.issueIid,
    issueProjectId: params.issueProjectId,
    issueProjectPath: params.issueProjectPath,
  });
  const issueSection = `## Related issue\n${issueRef}`;
  if (!description) {
    return issueSection;
  }
  return `${issueSection}\n\n${description}`;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function extractChangedFilePaths(changesPayload: any, maxFiles: number): string[] {
  const rows: any[] = Array.isArray(changesPayload?.changes) ? changesPayload.changes : [];
  const files: string[] = rows
    .map((item: any) => {
      if (typeof item?.new_path === "string" && item.new_path.trim()) {
        return item.new_path.trim();
      }
      if (typeof item?.old_path === "string" && item.old_path.trim()) {
        return item.old_path.trim();
      }
      return undefined;
    })
    .filter((item: string | undefined): item is string => Boolean(item));
  return [...new Set(files)].slice(0, maxFiles);
}

async function resolveBranchNameForAutoIssueComment(params: {
  toolName: string;
  branchName?: string;
  localRepoPath?: string;
}): Promise<string> {
  const fromArg = params.branchName?.trim();
  if (fromArg) {
    return fromArg;
  }

  const localRepoPath = params.localRepoPath?.trim();
  if (!localRepoPath) {
    throw new ToolInputError(
      `[${params.toolName}] Missing required parameter 'branch_name'. Provide 'branch_name' directly, or provide 'local_repo_path' to detect the current branch automatically.`,
    );
  }

  const currentBranch = await runGitInRepo(params.toolName, localRepoPath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);

  if (!currentBranch || currentBranch === "HEAD") {
    throw new ToolInputError(
      `[${params.toolName}] Failed to resolve a valid current branch from local_repo_path='${localRepoPath}'.`,
    );
  }

  return currentBranch.trim();
}

function buildIssueCommentFromMrChanges(params: {
  issueIid: number;
  issueTitle: string;
  issueDescription?: string;
  codeProjectId: number;
  mrIid: number;
  sourceBranch?: string;
  targetBranch?: string;
  changedFiles: string[];
  includeIssueContext: boolean;
}): string {
  const changeLines =
    params.changedFiles.length > 0
      ? params.changedFiles.map((filePath) => `- ${filePath}`).join("\n")
      : "- No changed files detected from merge request changes API.";

  const issueContext = params.includeIssueContext
    ? (() => {
        const summarySource = [params.issueTitle, params.issueDescription ?? ""]
          .map((item) => compactText(item))
          .filter((item) => item.length > 0)
          .join(" | ");
        const summary = clipText(summarySource, 240);
        return `### Current Issue Context
- Issue IID: ${params.issueIid}
- Requirement summary: ${summary}`;
      })()
    : "";

  const branchLine = params.sourceBranch ? `\n- Source branch: \`${params.sourceBranch}\`` : "";
  const targetBranchLine = params.targetBranch ? `\n- Target branch: \`${params.targetBranch}\`` : "";

  return `## Auto Comment Based on MR Changes
${issueContext ? `\n\n${issueContext}` : ""}

### Change Source
- Code project ID: ${params.codeProjectId}
- MR IID: ${params.mrIid}${branchLine}${targetBranchLine}

### Changed Files (from gitlab_get_mr_changes)
${changeLines}

### Notes
- This comment was generated automatically from MR changed-file analysis.`;
}

async function executeAnalyzeAndCreateIssueWorkflow(params: {
  toolName: string;
  requirementText: string;
  sourceText?: string;
  issueTemplate?: string;
  templateVariables?: Record<string, string>;
  englishSlug?: string;
  workType?: WorkType;
  summary?: string;
  issueProjectId: number;
  issueProjectPath?: string;
  codeProjectId?: number;
  codeProjectPath?: string;
  labels?: string[];
  label?: string;
  autoCreateLabels?: boolean;
  assigneeUsername?: string;
  assigneeUsernames?: string[];
  assignToCurrentUserIfMissing?: boolean;
}) {
  const initialLabels = (() => {
    const explicit = normalizeUniqueStringArray(params.labels);
    if (explicit && explicit.length > 0) {
      return explicit;
    }
    if (params.label?.trim()) {
      return [params.label.trim()];
    }
    const parsedType = params.workType
      ? normalizeWorkType(params.workType)
      : detectWorkType(params.requirementText);
    return detectSuggestedLabels(params.requirementText, parsedType);
  })();

  const titleLabel = params.label?.trim() || initialLabels[0];
  const parsed = parseRequirementMetadata({
    requirementText: params.requirementText,
    englishSlug: params.englishSlug,
    workType: params.workType,
    summary: params.summary,
    label: titleLabel,
  });

  const ensuredLabels = await ensureLabelsExist(
    params.toolName,
    params.issueProjectId,
    initialLabels,
    params.autoCreateLabels ?? true,
  );

  const issueDescription = buildIssueDescriptionFromInput({
    toolName: params.toolName,
    issueTemplate: params.issueTemplate,
    templateVariables: params.templateVariables,
    requirementText: params.requirementText,
    summary: parsed.summary,
    sourceText: params.sourceText,
    issueProjectId: params.issueProjectId,
    issueProjectPath: params.issueProjectPath,
    codeProjectId: params.codeProjectId,
    codeProjectPath: params.codeProjectPath,
    branchName: parsed.branchName,
    workType: parsed.workType,
    label: titleLabel,
  });

  const assigneeIds = await resolveIssueAssigneeIds(params.toolName, {
    assigneeUsernames: params.assigneeUsernames,
    assigneeUsername: params.assigneeUsername,
    assignToCurrentUserIfMissing: params.assignToCurrentUserIfMissing ?? true,
  });

  const issue = await gitlab.createIssue({
    projectId: params.issueProjectId,
    title: parsed.issueTitle,
    description: issueDescription,
    labels: ensuredLabels,
    assigneeIds,
  });

  return {
    parsed: {
      work_type: parsed.workType,
      commit_type: parsed.workType,
      summary: parsed.summary,
      issue_title: parsed.issueTitle,
      branch_name: parsed.branchName,
    },
    issue: {
      id: issue.id,
      iid: issue.iid,
      web_url: issue.web_url,
    },
    labels: ensuredLabels,
  };
}

async function executeIssueToMrFullWorkflow(params: {
  toolName: string;
  preparation: DeliveryPreparationRecord;
  deliveryMethod: DeliveryMethod;
  issueProjectId: number;
  issueProjectPath?: string;
  issueIid: number;
  codeProjectId: number;
  codeProjectPath?: string;
  targetBranch: string;
  branchName?: string;
  englishSlug?: string;
  workType?: WorkType;
  summary?: string;
  commitMessage?: string;
  commitActions?: CommitActionInput[];
  changeSummary: string;
  testPlan: string;
  label?: string;
  assigneeUsername?: string;
  checkoutLocalBranch?: boolean;
  issueCommentBody?: string;
  implementationSummary?: string;
  acceptanceSteps?: string;
  updateLog?: boolean;
  logPath?: string;
  logStatus?: string;
}) {
  const issue = await gitlab.getIssue(params.issueProjectId, params.issueIid);

  const issueTitle = typeof issue.title === "string" ? issue.title : `Issue ${params.issueIid}`;
  const requirementText = [issueTitle, typeof issue.description === "string" ? issue.description : ""]
    .filter((part) => part.trim().length > 0)
    .join("\n");

  const workType = params.workType
    ? normalizeWorkType(params.workType)
    : detectWorkType(requirementText || issueTitle);
  const summaryCandidate = params.summary?.trim() || getLabelStrippedSummary(issueTitle).trim();
  const summary = summaryCandidate || summarizeRequirement(requirementText || issueTitle, 30);
  const commitMessage =
    params.commitMessage?.trim() ||
    `${workType}: ${summary}\n\nRelated Issue: ${params.issueProjectId}#${params.issueIid}`;
  const computedBranchName =
    params.deliveryMethod === "local_git"
      ? params.preparation.workingBranch ?? params.branchName
      : params.branchName ??
        buildBranchName({
          workType,
          englishSlug: params.englishSlug,
          requirementText: requirementText || issueTitle,
        });
  if (!computedBranchName) {
    missingParam(params.toolName, "branch_name");
  }
  if (
    params.deliveryMethod === "local_git" &&
    params.branchName?.trim() &&
    params.preparation.workingBranch &&
    params.branchName.trim() !== params.preparation.workingBranch
  ) {
    throw new ToolInputError(
      `[${params.toolName}] branch_name='${params.branchName.trim()}' does not match preparation working_branch='${params.preparation.workingBranch}'. Re-run workflow_prepare_delivery_workspace or stop overriding branch_name.`,
    );
  }

  let branch: { name: string; web_url?: string } = { name: computedBranchName };
  let commit:
    | {
        id?: unknown;
        short_id?: unknown;
        title?: unknown;
        web_url?: unknown;
      }
    | undefined;
  let changedFiles: string[] = [];

  if (params.deliveryMethod === "local_git") {
    const localCommit = await commitAndPushLocalBranch({
      toolName: params.toolName,
      repoPath: params.preparation.repoPath,
      remoteName: params.preparation.remoteName,
      workingBranch: computedBranchName,
      commitMessage,
    });
    branch = { name: localCommit.branch_name };
    commit = {
      id: localCommit.commit_sha,
      short_id: localCommit.short_sha,
      title: localCommit.title,
    };
    changedFiles = localCommit.changed_files;
  } else {
    if (!params.commitActions) {
      missingParam(params.toolName, "commit_actions");
    }
    validateCommitActions(params.toolName, params.commitActions);
    const createdBranch = await gitlab.createBranch(
      params.codeProjectId,
      computedBranchName,
      params.preparation.baseBranch,
    );
    branch = {
      name: createdBranch.name,
      web_url: createdBranch.web_url,
    };
    const createdCommit = await gitlab.createCommit({
      projectId: params.codeProjectId,
      branch: computedBranchName,
      commitMessage,
      actions: params.commitActions,
    });
    commit = {
      id: createdCommit?.id,
      short_id: createdCommit?.short_id,
      title: createdCommit?.title,
      web_url: createdCommit?.web_url,
    };
    changedFiles = [
      ...new Set(
        params.commitActions
          .map((action) => action.file_path?.trim())
          .filter((path): path is string => Boolean(path)),
      ),
    ];
  }

  const mr = await createWorkflowMergeRequest({
    issueProjectId: params.issueProjectId,
    issueProjectPath: params.issueProjectPath,
    issueIid: params.issueIid,
    codeProjectId: params.codeProjectId,
    sourceBranch: computedBranchName,
    targetBranch: params.targetBranch,
    workType,
    summary,
    changeSummary: params.changeSummary,
    testPlan: params.testPlan,
    label: params.label,
    assigneeUsername: params.assigneeUsername,
  });

  const issueCommentBody =
    params.issueCommentBody?.trim() ||
    renderIssueCompletionComment({
      changedFiles,
      branchName: computedBranchName,
      codeProjectPath: params.codeProjectPath,
      implementationSummary: params.implementationSummary ?? params.changeSummary,
      acceptanceSteps: params.acceptanceSteps ?? params.testPlan,
    });
  const issueComment = await gitlab.createIssueNote(
    params.issueProjectId,
    params.issueIid,
    issueCommentBody,
  );

  let localCheckout:
    | {
        repo_path: string;
        remote_name: string;
        branch_name: string;
        commands: string[];
        current_branch: string;
        head_sha: string;
      }
    | undefined;
  if (params.deliveryMethod === "local_git") {
    localCheckout = {
      repo_path: params.preparation.repoPath,
      remote_name: params.preparation.remoteName,
      branch_name: computedBranchName,
      commands: [],
      current_branch: await getCurrentBranchName(params.toolName, params.preparation.repoPath),
      head_sha: await getHeadSha(params.toolName, params.preparation.repoPath),
    };
  } else if (params.checkoutLocalBranch) {
    localCheckout = await syncAndCheckoutLocalBranch({
      toolName: params.toolName,
      repoPath: params.preparation.repoPath,
      remoteName: params.preparation.remoteName,
      branchName: computedBranchName,
      baseBranch: params.preparation.baseBranch,
    });
  }

  let log: { updated: boolean; path?: string } = { updated: false };
  if (params.updateLog) {
    const logPath = requireStringParam(
      params.toolName,
      "log_path",
      params.logPath,
      config.defaults.issueLogPath,
      "WORKFLOW_ISSUE_LOG_PATH",
    );
    const logStatus = params.logStatus ?? "mr_pending_review";
    const markdown = renderIssueLogEntry({
      date: getTodayDateString(),
      issueTitle: issueTitle,
      issueIid: params.issueIid,
      issueProjectPath: params.issueProjectPath,
      issueProjectId: params.issueProjectId,
      issueWebUrl: typeof issue.web_url === "string" ? issue.web_url : "",
      mrIid: mr.iid,
      mrUrl: typeof mr.web_url === "string" ? mr.web_url : "",
      branchName: computedBranchName,
      codeProjectPath: params.codeProjectPath,
      codeProjectId: params.codeProjectId,
      summary: params.changeSummary,
      status: logStatus,
    });
    const path = await appendIssueLogMarkdown(params.preparation.repoPath, logPath, markdown);
    await updateIssueLogWithMr({
      repoPath: params.preparation.repoPath,
      logPath,
      issueIid: params.issueIid,
      mrIid: mr.iid,
      mrUrl: typeof mr.web_url === "string" ? mr.web_url : "",
      status: logStatus,
    });
    log = { updated: true, path };
  }

  return {
    issue: {
      id: issue.id,
      iid: issue.iid,
      web_url: issue.web_url,
    },
    branch: {
      name: branch.name,
      web_url: branch.web_url,
    },
    commit: {
      id: commit?.id,
      short_id: commit?.short_id,
      title: commit?.title,
      web_url: commit?.web_url,
    },
    merge_request: {
      id: mr.id,
      iid: mr.iid,
      title: typeof mr.title === "string" ? mr.title : String(mr.title ?? ""),
      web_url: typeof mr.web_url === "string" ? mr.web_url : "",
    },
    issue_comment: {
      note_id: issueComment.id,
      body: issueCommentBody,
      web_url: issueComment?.noteable_url ?? null,
    },
    local_checkout: localCheckout,
    log,
  };
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
  "workflow_requirement_to_issue",
  {
    description:
      "Use when requirement text should only create a GitLab issue and stop there. Do not combine this with workflow_requirement_to_delivery for the same user request. If the issue is already created, continue with workflow_issue_to_delivery instead of calling this tool again.",
    outputSchema: workflowAnalyzeAndCreateIssueOutputSchema,
    inputSchema: {
      requirement_text: z.string().min(1).describe("Raw user requirement text."),
      source_text: z
        .string()
        .optional()
        .describe("Optional extra background text for the default issue template."),
      issue_template: z
        .string()
        .optional()
        .describe(
          "Optional full issue markdown template. Supported built-in variables include {{summary}}, {{requirement_text}}, {{source_text}}, {{expected_change}}, {{issue_project_id}}, {{code_project_id}}, {{issue_project_path}}, {{code_project_path}}, {{branch_name}}, {{work_type}}, {{label}}.",
        ),
      template_variables: z
        .record(z.string())
        .optional()
        .describe("Optional custom variables map merged into issue_template rendering."),
      english_slug: z.string().optional().describe("Optional branch slug."),
      work_type: workTypeSchema
        .optional()
        .describe("Optional git/conventional work type override like feat, fix, docs, refactor, hotfix, feature."),
      summary: z.string().optional().describe("Optional issue summary."),
      issue_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("Issue project ID.", "WORKFLOW_ISSUE_PROJECT_ID")),
      issue_project_path: z
        .string()
        .optional()
        .describe(
          envBackedDescription("Issue project path for issue template variables.", "WORKFLOW_ISSUE_PROJECT_PATH"),
        ),
      code_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("Optional code project ID used in issue template variables.", "WORKFLOW_CODE_PROJECT_ID")),
      code_project_path: z
        .string()
        .optional()
        .describe(envBackedDescription("Code project path for template/render context.", "WORKFLOW_CODE_PROJECT_PATH")),
      labels: z.array(z.string()).optional().describe("Issue labels list."),
      label: z
        .string()
        .optional()
        .describe(envBackedDescription("Issue title prefix label and fallback issue label.", "WORKFLOW_LABEL")),
      auto_create_labels: z
        .boolean()
        .optional()
        .describe("When true, create missing labels in issue project automatically."),
      assignee_username: z
        .string()
        .optional()
        .describe(envBackedDescription("Single assignee username.", "WORKFLOW_ASSIGNEE_USERNAME")),
      assignee_usernames: z.array(z.string()).optional().describe("Assignee usernames list."),
      assign_to_current_user_if_missing: z
        .boolean()
        .optional()
        .describe("When true, assign issue to current token user if no assignee is provided."),
    },
  },
  withToolErrorHandling("workflow_requirement_to_issue", async (args) => {
    const issueProjectId = requireNumberParam(
      "workflow_requirement_to_issue",
      "issue_project_id",
      args.issue_project_id,
      config.defaults.issueProjectId,
      "WORKFLOW_ISSUE_PROJECT_ID",
    );
    enforceIssueProjectLock("workflow_requirement_to_issue", issueProjectId);

    const codeProjectId =
      args.code_project_id ??
      config.defaults.codeProjectId;
    if (codeProjectId !== undefined) {
      ensurePositiveIntOptional("workflow_requirement_to_issue", "code_project_id", codeProjectId);
      enforceCodeProjectLock("workflow_requirement_to_issue", codeProjectId);
    }

    const issueProjectPath = optionalStringParam(args.issue_project_path, config.defaults.issueProjectPath);
    const codeProjectPath = optionalStringParam(args.code_project_path, config.defaults.codeProjectPath);
    const result = await executeAnalyzeAndCreateIssueWorkflow({
      toolName: "workflow_requirement_to_issue",
      requirementText: args.requirement_text,
      sourceText: args.source_text,
      issueTemplate: args.issue_template,
      templateVariables: args.template_variables,
      englishSlug: args.english_slug,
      workType: args.work_type,
      summary: args.summary,
      issueProjectId,
      issueProjectPath,
      codeProjectId,
      codeProjectPath,
      labels: args.labels,
      label: optionalStringParam(args.label, config.defaults.label),
      autoCreateLabels: args.auto_create_labels,
      assigneeUsername: optionalStringParam(args.assignee_username, config.defaults.assigneeUsername),
      assigneeUsernames: args.assignee_usernames,
      assignToCurrentUserIfMissing: args.assign_to_current_user_if_missing,
    });

    return {
      parsed: result.parsed,
      issue: result.issue,
    };
  }),
);

server.registerTool(
  "workflow_issue_log_append",
  {
    description: "Use when only local issue log markdown should be appended. This tool does not create MR or commit.",
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
        .describe(envBackedDescription("Issue project ID.", "WORKFLOW_ISSUE_PROJECT_ID")),
      issue_project_path: z
        .string()
        .optional()
        .describe(envBackedDescription("Issue project path.", "WORKFLOW_ISSUE_PROJECT_PATH")),
      code_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("Code project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      code_project_path: z
        .string()
        .optional()
        .describe(envBackedDescription("Code project path.", "WORKFLOW_CODE_PROJECT_PATH")),
      repo_path: z.string().min(1).describe("Local repository path used as the base for resolving log_path."),
      log_path: z
        .string()
        .optional()
        .describe(envBackedDescription("Issue log path.", "WORKFLOW_ISSUE_LOG_PATH")),
    },
  },
  withToolErrorHandling("workflow_issue_log_append", async (args) => {
    const issueProjectId = requireNumberParam(
      "workflow_issue_log_append",
      "issue_project_id",
      args.issue_project_id,
      config.defaults.issueProjectId,
      "WORKFLOW_ISSUE_PROJECT_ID",
    );
    const codeProjectId = requireNumberParam(
      "workflow_issue_log_append",
      "code_project_id",
      args.code_project_id,
      config.defaults.codeProjectId,
      "WORKFLOW_CODE_PROJECT_ID",
    );
    enforceProjectLocks("workflow_issue_log_append", issueProjectId, codeProjectId);
    const repoPath = requireStringParam(
      "workflow_issue_log_append",
      "repo_path",
      args.repo_path,
      undefined,
    );

    const logPath = requireStringParam(
      "workflow_issue_log_append",
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

    const path = await appendIssueLogMarkdown(repoPath, logPath, markdown);
    return { updated: true, path };
  }),
);

server.registerTool(
  "workflow_review_mr_post_comment",
  {
    description:
      "Two-step MR review workflow. Step 1: call with prepare_review_context=true to fetch review_prompt + diffs for LLM review. Step 2: let the LLM inspect that context, then call again with review_comment_body to post the final review comment (optional approval).",
    outputSchema: workflowReviewMrAndCommentOutputSchema,
    inputSchema: {
      code_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("Code project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      mr_iid: z.number().int().positive().describe("Merge request IID."),
      review_comment_body: z
        .string()
        .optional()
        .describe(
          "Step 2 of 2. Final review comment markdown body, generated after the LLM inspects prepared_review.review_prompt + prepared_review.diffs from the prepare step.",
        ),
      prepare_review_context: z
        .boolean()
        .optional()
        .describe(
          "Step 1 of 2. When true, do not post a comment. Return concise review prompt text plus MR diff context for an external LLM. After the LLM generates review_comment_body, call this tool again without prepare_review_context to post the comment.",
        ),
      review_summary: z
        .string()
        .optional()
        .describe("Short review summary used when review_comment_body is missing."),
      include_changes: z
        .boolean()
        .optional()
        .describe("Whether to include changed files list in generated review comment."),
      include_existing_notes: z
        .boolean()
        .optional()
        .describe("Whether to load existing MR notes and include count in generated comment."),
      approve: z
        .boolean()
        .optional()
        .describe("Whether to approve MR after posting review comment."),
      sha: z
        .string()
        .optional()
        .describe("Optional expected MR HEAD SHA when approve=true."),
      max_changed_files: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of changed files included in prepared review context. Default 20."),
      max_diff_chars_per_file: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum diff characters returned per file in prepared review context. Default 12000."),
    },
  },
  withToolErrorHandling("workflow_review_mr_post_comment", async (args) => {
    const codeProjectId = requireNumberParam(
      "workflow_review_mr_post_comment",
      "code_project_id",
      args.code_project_id,
      config.defaults.codeProjectId,
      "WORKFLOW_CODE_PROJECT_ID",
    );
    enforceCodeProjectLock("workflow_review_mr_post_comment", codeProjectId);

    const mr = await gitlab.getMergeRequest(codeProjectId, args.mr_iid);
    const prepareReviewContext = args.prepare_review_context ?? false;
    const includeChanges = args.include_changes ?? true;
    const includeExistingNotes = args.include_existing_notes ?? false;
    const maxChangedFiles =
      ensurePositiveIntRangeOptional(
        "workflow_review_mr_post_comment",
        "max_changed_files",
        args.max_changed_files,
        50,
      ) ?? 20;
    const maxDiffCharsPerFile =
      ensurePositiveIntRangeOptional(
        "workflow_review_mr_post_comment",
        "max_diff_chars_per_file",
        args.max_diff_chars_per_file,
        40000,
      ) ?? 12000;

    if (prepareReviewContext && !includeChanges) {
      invalidParam(
        "workflow_review_mr_post_comment",
        "include_changes",
        "must be true when prepare_review_context=true",
      );
    }

    let changedFileLines: string[] = [];
    let changesPayload: any;
    if (includeChanges) {
      changesPayload = await gitlab.getMergeRequestChanges(codeProjectId, args.mr_iid);
      changedFileLines = ((changesPayload?.changes ?? []) as any[])
        .map((item) => (typeof item?.new_path === "string" ? item.new_path : item?.old_path))
        .filter((path): path is string => typeof path === "string")
        .slice(0, maxChangedFiles)
        .map((path) => `- ${path}`);
    }

    let existingNotesCount: number | undefined;
    if (includeExistingNotes) {
      const notes = await gitlab.getMergeRequestNotes(codeProjectId, args.mr_iid, {
        sort: "asc",
        orderBy: "created_at",
      });
      existingNotesCount = (notes as any[]).length;
    }

    if (prepareReviewContext) {
      return {
        mode: "prepared" as const,
        merge_request: {
          id: mr.id,
          iid: mr.iid,
          title: mr.title,
          web_url: mr.web_url,
        },
        prepared_review: buildPreparedMrReviewContext({
          reviewSummary: args.review_summary,
          existingNotesCount,
          changesPayload,
          maxFiles: maxChangedFiles,
          maxDiffCharsPerFile,
        }),
      };
    }

    const reviewBody = args.review_comment_body?.trim();
    if (!reviewBody) {
      throw new ToolInputError(
        "[workflow_review_mr_post_comment] Missing required parameter 'review_comment_body'. Two-step flow required: first call with prepare_review_context=true, let the LLM review 'prepared_review.review_prompt' + 'prepared_review.diffs', then call this tool again with the generated review_comment_body to post the comment.",
      );
    }

    const note = await gitlab.createMergeRequestNote(codeProjectId, args.mr_iid, reviewBody);

    let approval: { approved: boolean; response?: unknown } | undefined;
    if (args.approve) {
      const approvalResponse = await gitlab.approveMergeRequest(
        codeProjectId,
        args.mr_iid,
        args.sha?.trim(),
      );
      approval = {
        approved: true,
        response: approvalResponse,
      };
    }

    return {
      mode: "posted" as const,
      merge_request: {
        id: mr.id,
        iid: mr.iid,
        title: mr.title,
        web_url: mr.web_url,
      },
      review_note: {
        note_id: note.id,
        body: reviewBody,
        web_url: note?.noteable_url ?? null,
      },
      approval,
    };
  }),
);

server.registerTool(
  "workflow_prepare_delivery_workspace",
  {
    description:
      "Use before delivery workflows. Pass the explicit local repo_path for the target project. This tool verifies a clean local repo, refreshes the latest base branch, and returns a preparation_key that workflow_issue_to_delivery/workflow_requirement_to_delivery must provide. When delivery_method=local_git, it also creates and checks out the local working branch where code changes should be made.",
    outputSchema: workflowPrepareDeliveryWorkspaceOutputSchema,
    inputSchema: {
      repo_path: z.string().min(1).describe("Local repository path."),
      delivery_method: deliveryMethodSchema
        .optional()
        .describe(envBackedDescription("Delivery implementation mode.", "WORKFLOW_DELIVERY_METHOD")),
      remote_name: z
        .string()
        .optional()
        .describe(envBackedDescription("Git remote name.", "WORKFLOW_LOCAL_REMOTE_NAME")),
      base_branch: z
        .string()
        .optional()
        .describe(envBackedDescription("Base branch to refresh before code generation.", "WORKFLOW_BASE_BRANCH")),
      branch_name: z
        .string()
        .optional()
        .describe("Optional branch name override. Required for local_git when no summary/requirement_text is provided."),
      english_slug: z.string().optional().describe("Optional English slug used when generating a local working branch."),
      work_type: workTypeSchema
        .optional()
        .describe("Optional git/conventional work type override when generating a local working branch."),
      summary: z.string().optional().describe("Optional summary used to help generate a local working branch."),
      requirement_text: z
        .string()
        .optional()
        .describe("Optional requirement text used to help generate a local working branch."),
    },
  },
  withToolErrorHandling("workflow_prepare_delivery_workspace", async (args) => {
    const repoPath = requireStringParam(
      "workflow_prepare_delivery_workspace",
      "repo_path",
      args.repo_path,
      undefined,
    );
    const remoteName = requireStringParam(
      "workflow_prepare_delivery_workspace",
      "remote_name",
      args.remote_name,
      config.defaults.localGitRemoteName,
      "WORKFLOW_LOCAL_REMOTE_NAME",
    );
    const baseBranch = requireStringParam(
      "workflow_prepare_delivery_workspace",
      "base_branch",
      args.base_branch,
      config.defaults.baseBranch,
      "WORKFLOW_BASE_BRANCH",
    );
    const deliveryMethod = normalizeDeliveryMethod(
      optionalStringParam(args.delivery_method, config.defaults.deliveryMethod) ?? "local_git",
    );
    const workingBranch = resolvePrepareWorkingBranch({
      toolName: "workflow_prepare_delivery_workspace",
      deliveryMethod,
      branchName: args.branch_name,
      englishSlug: args.english_slug,
      workType: args.work_type,
      summary: args.summary,
      requirementText: args.requirement_text,
    });

    return prepareDeliveryWorkspace({
      toolName: "workflow_prepare_delivery_workspace",
      repoPath,
      remoteName,
      baseBranch,
      deliveryMethod,
      workingBranch,
    });
  }),
);

server.registerTool(
  "workflow_sync_local_branch",
  {
    description:
      "Use when local repository should fetch/pull and switch to a target branch. Local git operations only.",
    outputSchema: workflowLocalSyncCheckoutBranchOutputSchema,
    inputSchema: {
      branch_name: z.string().min(1).describe("Target branch to checkout locally."),
      repo_path: z.string().min(1).describe("Local repository path."),
      remote_name: z
        .string()
        .optional()
        .describe(envBackedDescription("Git remote name.", "WORKFLOW_LOCAL_REMOTE_NAME")),
      base_branch: z
        .string()
        .optional()
        .describe(envBackedDescription("Optional base branch to pull before checkout.", "WORKFLOW_BASE_BRANCH")),
    },
  },
  withToolErrorHandling("workflow_sync_local_branch", async (args) => {
    const repoPath = requireStringParam(
      "workflow_sync_local_branch",
      "repo_path",
      args.repo_path,
      undefined,
    );
    const remoteName = requireStringParam(
      "workflow_sync_local_branch",
      "remote_name",
      args.remote_name,
      config.defaults.localGitRemoteName,
      "WORKFLOW_LOCAL_REMOTE_NAME",
    );
    const baseBranch = optionalStringParam(args.base_branch, config.defaults.baseBranch);
    return syncAndCheckoutLocalBranch({
      toolName: "workflow_sync_local_branch",
      repoPath,
      remoteName,
      branchName: args.branch_name.trim(),
      baseBranch,
    });
  }),
);

server.registerTool(
  "workflow_issue_to_delivery",
  {
    description:
      "Use when an existing issue_iid should be delivered end-to-end: branch, commit, MR, issue comment, local sync, and issue log. Before composing commit_actions, first call workflow_prepare_delivery_workspace and use its preparation_key here. Then inspect the issue text and any screenshots. If the issue may contain image references, call gitlab_get_issue_images(project_id, issue_iid, include_base64=true) first and review the returned image blocks. Do not call this twice for the same issue or same user request. If the issue and MR may already exist, inspect GitLab first before retrying.",
    outputSchema: workflowIssueToMrFullOutputSchema,
    inputSchema: {
      preparation_key: z
        .string()
        .min(1)
        .describe(
          "Required key returned by workflow_prepare_delivery_workspace. Delivery is rejected if the prepared base branch is no longer current.",
        ),
      delivery_method: deliveryMethodSchema
        .optional()
        .describe(envBackedDescription("Delivery implementation mode.", "WORKFLOW_DELIVERY_METHOD")),
      issue_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("Issue project ID.", "WORKFLOW_ISSUE_PROJECT_ID")),
      issue_project_path: z
        .string()
        .optional()
        .describe(envBackedDescription("Issue project path.", "WORKFLOW_ISSUE_PROJECT_PATH")),
      issue_iid: z.number().int().positive().describe("Issue IID."),
      issue_images_reviewed: z
        .boolean()
        .optional()
        .describe(
          "Set to true only after you have inspected issue images with gitlab_get_issue_images(..., include_base64=true). Required when the target issue contains screenshots or image references.",
        ),
      code_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("Code project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      code_project_path: z
        .string()
        .optional()
        .describe(envBackedDescription("Code project path.", "WORKFLOW_CODE_PROJECT_PATH")),
      target_branch: z
        .string()
        .optional()
        .describe(envBackedDescription("MR target branch.", "WORKFLOW_TARGET_BRANCH")),
      branch_name: z.string().optional().describe("Optional branch name override."),
      english_slug: z.string().optional().describe("Optional English slug used when generating branch name."),
      work_type: workTypeSchema
        .optional()
        .describe("Optional git/conventional work type override like feat, fix, docs, refactor, hotfix, feature."),
      summary: z.string().optional().describe("Optional summary used for branch/commit/MR title."),
      commit_message: z.string().optional().describe("Optional commit message."),
      commit_actions: z
        .array(commitActionSchema)
        .optional()
        .describe("Commit actions list. Required when delivery_method=remote_api."),
      change_summary: z.string().min(1).describe("Change summary used in MR description and issue log."),
      test_plan: z.string().min(1).describe("Test/acceptance plan used in MR description."),
      label: z
        .string()
        .optional()
        .describe(envBackedDescription("Optional MR label.", "WORKFLOW_LABEL")),
      assignee_username: z
        .string()
        .optional()
        .describe(envBackedDescription("Optional assignee username for MR.", "WORKFLOW_ASSIGNEE_USERNAME")),
      checkout_local_branch: z
        .boolean()
        .optional()
        .describe(
          envBackedDescription(
            "Whether to fetch/pull and switch local repo to target branch.",
            "WORKFLOW_CHECKOUT_LOCAL_BRANCH",
          ),
        ),
      issue_comment_body: z.string().optional().describe("Direct issue comment body."),
      implementation_summary: z
        .string()
        .optional()
        .describe("Implementation summary for generated issue comment."),
      acceptance_steps: z
        .string()
        .optional()
        .describe("Acceptance steps for generated issue comment."),
      update_log: z
        .boolean()
        .optional()
        .describe(
          envBackedDescription("Whether to update local issue log.", "WORKFLOW_UPDATE_ISSUE_LOG"),
        ),
      log_path: z
        .string()
        .optional()
        .describe(
          envBackedDescription(
            "Issue log path.",
            "WORKFLOW_ISSUE_LOG_PATH",
            "This field matters only when update_log=true.",
          ),
        ),
      log_status: z.string().optional().describe("Issue log status text."),
    },
  },
  withToolErrorHandling("workflow_issue_to_delivery", async (args) => {
    const issueProjectId = requireNumberParam(
      "workflow_issue_to_delivery",
      "issue_project_id",
      args.issue_project_id,
      config.defaults.issueProjectId,
      "WORKFLOW_ISSUE_PROJECT_ID",
    );
    const codeProjectId = requireNumberParam(
      "workflow_issue_to_delivery",
      "code_project_id",
      args.code_project_id,
      config.defaults.codeProjectId,
      "WORKFLOW_CODE_PROJECT_ID",
    );
    enforceProjectLocks("workflow_issue_to_delivery", issueProjectId, codeProjectId);

    const preparation = await requireDeliveryPreparation({
      toolName: "workflow_issue_to_delivery",
      preparationKey: args.preparation_key,
    });
    const deliveryMethod = normalizeDeliveryMethod(
      optionalStringParam(args.delivery_method, config.defaults.deliveryMethod) ??
        preparation.deliveryMethod,
    );
    if (deliveryMethod !== preparation.deliveryMethod) {
      throw new ToolInputError(
        `[workflow_issue_to_delivery] delivery_method='${deliveryMethod}' does not match preparation_key delivery_method='${preparation.deliveryMethod}'. Re-run workflow_prepare_delivery_workspace.`,
      );
    }

    if (args.issue_images_reviewed !== true) {
      const hasIssueImages = await issueContainsImageReferences(issueProjectId, args.issue_iid);
      if (hasIssueImages) {
        throw new ToolInputError(
          `[workflow_issue_to_delivery] Issue ${issueProjectId}#${args.issue_iid} contains image references. Before generating commit_actions, call gitlab_get_issue_images with include_base64=true, inspect the returned image content blocks, then call workflow_issue_to_delivery again with issue_images_reviewed=true.`,
        );
      }
    }

    const targetBranch = requireStringParam(
      "workflow_issue_to_delivery",
      "target_branch",
      args.target_branch,
      config.defaults.targetBranch,
      "WORKFLOW_TARGET_BRANCH",
    );

    let commitActions: CommitActionInput[] | undefined;
    if (deliveryMethod === "remote_api" && !args.commit_actions) {
      missingParam("workflow_issue_to_delivery", "commit_actions");
    }
    if (args.commit_actions) {
      commitActions = args.commit_actions.map((action) => ({
        action: action.action,
        file_path: action.file_path?.trim(),
        previous_path: action.previous_path?.trim(),
        content: action.content,
        encoding: action.encoding,
        execute_filemode: action.execute_filemode,
        last_commit_id: action.last_commit_id?.trim(),
      }));
    }

    const delivery = await executeIssueToMrFullWorkflow({
      toolName: "workflow_issue_to_delivery",
      preparation,
      deliveryMethod,
      issueProjectId,
      issueProjectPath: optionalStringParam(args.issue_project_path, config.defaults.issueProjectPath),
      issueIid: args.issue_iid,
      codeProjectId,
      codeProjectPath: optionalStringParam(args.code_project_path, config.defaults.codeProjectPath),
      targetBranch,
      branchName: args.branch_name?.trim(),
      englishSlug: args.english_slug?.trim(),
      workType: args.work_type,
      summary: args.summary?.trim(),
      commitMessage: args.commit_message?.trim(),
      commitActions,
      changeSummary: args.change_summary,
      testPlan: args.test_plan,
      label: optionalStringParam(args.label, config.defaults.label),
      assigneeUsername: optionalStringParam(args.assignee_username, config.defaults.assigneeUsername),
      checkoutLocalBranch: args.checkout_local_branch ?? config.defaults.checkoutLocalBranch,
      issueCommentBody: args.issue_comment_body,
      implementationSummary: args.implementation_summary,
      acceptanceSteps: args.acceptance_steps,
      updateLog: args.update_log ?? config.defaults.updateIssueLog,
      logPath: args.log_path,
      logStatus: args.log_status,
    });

    await deleteDeliveryPreparationRecord(
      getDeliveryPreparationStatePath(),
      preparation.preparationKey,
    );

    return delivery;
  }),
);

server.registerTool(
  "workflow_requirement_to_delivery",
  {
    description:
      "Use when requirement text should run the full chain once: create issue, then continue in the same workflow through branch, commit, MR, issue comment, local sync, and issue log. Before composing commit_actions, first call workflow_prepare_delivery_workspace and use its preparation_key here. Do not combine this with workflow_requirement_to_issue or workflow_issue_to_delivery for the same user request.",
    outputSchema: workflowRequirementToDeliveryFullOutputSchema,
    inputSchema: {
      requirement_text: z.string().min(1).describe("Raw user requirement text."),
      preparation_key: z
        .string()
        .min(1)
        .describe(
          "Required key returned by workflow_prepare_delivery_workspace. Delivery is rejected if the prepared base branch is no longer current.",
        ),
      delivery_method: deliveryMethodSchema
        .optional()
        .describe(envBackedDescription("Delivery implementation mode.", "WORKFLOW_DELIVERY_METHOD")),
      source_text: z
        .string()
        .optional()
        .describe("Optional extra background text for the default issue template."),
      issue_template: z
        .string()
        .optional()
        .describe(
          "Optional full issue markdown template. Supported built-in variables include {{summary}}, {{requirement_text}}, {{source_text}}, {{expected_change}}, {{issue_project_id}}, {{code_project_id}}, {{issue_project_path}}, {{code_project_path}}, {{branch_name}}, {{work_type}}, {{label}}.",
        ),
      template_variables: z
        .record(z.string())
        .optional()
        .describe("Optional custom variables map merged into issue_template rendering."),
      english_slug: z.string().optional().describe("Optional branch slug."),
      work_type: workTypeSchema
        .optional()
        .describe("Optional git/conventional work type override like feat, fix, docs, refactor, hotfix, feature."),
      summary: z.string().optional().describe("Optional short summary used for issue and MR title."),
      issue_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("Issue project ID.", "WORKFLOW_ISSUE_PROJECT_ID")),
      issue_project_path: z
        .string()
        .optional()
        .describe(envBackedDescription("Issue project path.", "WORKFLOW_ISSUE_PROJECT_PATH")),
      code_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("Code project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      code_project_path: z
        .string()
        .optional()
        .describe(envBackedDescription("Code project path.", "WORKFLOW_CODE_PROJECT_PATH")),
      labels: z.array(z.string()).optional().describe("Issue labels list."),
      label: z
        .string()
        .optional()
        .describe(envBackedDescription("Issue title prefix and fallback issue label.", "WORKFLOW_LABEL")),
      auto_create_labels: z
        .boolean()
        .optional()
        .describe("Whether to auto-create missing labels."),
      assignee_username: z
        .string()
        .optional()
        .describe(envBackedDescription("Single assignee username.", "WORKFLOW_ASSIGNEE_USERNAME")),
      assignee_usernames: z.array(z.string()).optional().describe("Assignee usernames list."),
      assign_to_current_user_if_missing: z
        .boolean()
        .optional()
        .describe("Whether to assign issue to current user when no assignee is provided."),
      target_branch: z
        .string()
        .optional()
        .describe(envBackedDescription("MR target branch.", "WORKFLOW_TARGET_BRANCH")),
      branch_name: z.string().optional().describe("Optional branch name override."),
      commit_message: z.string().optional().describe("Optional commit message."),
      commit_actions: z
        .array(commitActionSchema)
        .optional()
        .describe("Commit actions list. Required when delivery_method=remote_api."),
      change_summary: z.string().min(1).describe("Change summary used in MR/log."),
      test_plan: z.string().min(1).describe("Test/acceptance plan used in MR description and issue comment."),
      checkout_local_branch: z
        .boolean()
        .optional()
        .describe(
          envBackedDescription(
            "Whether to sync and switch local repo to created branch.",
            "WORKFLOW_CHECKOUT_LOCAL_BRANCH",
          ),
        ),
      issue_comment_body: z.string().optional().describe("Direct issue comment body."),
      implementation_summary: z
        .string()
        .optional()
        .describe("Implementation summary for generated issue comment."),
      acceptance_steps: z.string().optional().describe("Acceptance steps for generated issue comment."),
      update_log: z
        .boolean()
        .optional()
        .describe(
          envBackedDescription("Whether to update local issue log.", "WORKFLOW_UPDATE_ISSUE_LOG"),
        ),
      log_path: z
        .string()
        .optional()
        .describe(
          envBackedDescription(
            "Issue log path.",
            "WORKFLOW_ISSUE_LOG_PATH",
            "This field matters only when update_log=true.",
          ),
        ),
      log_status: z.string().optional().describe("Issue log status text."),
    },
  },
  withToolErrorHandling("workflow_requirement_to_delivery", async (args) => {
    const issueProjectId = requireNumberParam(
      "workflow_requirement_to_delivery",
      "issue_project_id",
      args.issue_project_id,
      config.defaults.issueProjectId,
      "WORKFLOW_ISSUE_PROJECT_ID",
    );
    const codeProjectId = requireNumberParam(
      "workflow_requirement_to_delivery",
      "code_project_id",
      args.code_project_id,
      config.defaults.codeProjectId,
      "WORKFLOW_CODE_PROJECT_ID",
    );
    enforceProjectLocks("workflow_requirement_to_delivery", issueProjectId, codeProjectId);

    const preparation = await requireDeliveryPreparation({
      toolName: "workflow_requirement_to_delivery",
      preparationKey: args.preparation_key,
    });
    const deliveryMethod = normalizeDeliveryMethod(
      optionalStringParam(args.delivery_method, config.defaults.deliveryMethod) ??
        preparation.deliveryMethod,
    );
    if (deliveryMethod !== preparation.deliveryMethod) {
      throw new ToolInputError(
        `[workflow_requirement_to_delivery] delivery_method='${deliveryMethod}' does not match preparation_key delivery_method='${preparation.deliveryMethod}'. Re-run workflow_prepare_delivery_workspace.`,
      );
    }

    const issueProjectPath = optionalStringParam(args.issue_project_path, config.defaults.issueProjectPath);
    const codeProjectPath = optionalStringParam(args.code_project_path, config.defaults.codeProjectPath);

    const created = await executeAnalyzeAndCreateIssueWorkflow({
      toolName: "workflow_requirement_to_delivery",
      requirementText: args.requirement_text,
      sourceText: args.source_text,
      issueTemplate: args.issue_template,
      templateVariables: args.template_variables,
      englishSlug: args.english_slug,
      workType: args.work_type,
      summary: args.summary,
      issueProjectId,
      issueProjectPath,
      codeProjectId,
      codeProjectPath,
      labels: args.labels,
      label: optionalStringParam(args.label, config.defaults.label),
      autoCreateLabels: args.auto_create_labels,
      assigneeUsername: optionalStringParam(args.assignee_username, config.defaults.assigneeUsername),
      assigneeUsernames: args.assignee_usernames,
      assignToCurrentUserIfMissing: args.assign_to_current_user_if_missing,
    });

    const targetBranch = requireStringParam(
      "workflow_requirement_to_delivery",
      "target_branch",
      args.target_branch,
      config.defaults.targetBranch,
      "WORKFLOW_TARGET_BRANCH",
    );

    let commitActions: CommitActionInput[] | undefined;
    if (deliveryMethod === "remote_api" && !args.commit_actions) {
      missingParam("workflow_requirement_to_delivery", "commit_actions");
    }
    if (args.commit_actions) {
      commitActions = args.commit_actions.map((action) => ({
        action: action.action,
        file_path: action.file_path?.trim(),
        previous_path: action.previous_path?.trim(),
        content: action.content,
        encoding: action.encoding,
        execute_filemode: action.execute_filemode,
        last_commit_id: action.last_commit_id?.trim(),
      }));
    }

    const delivery = await executeIssueToMrFullWorkflow({
      toolName: "workflow_requirement_to_delivery",
      preparation,
      deliveryMethod,
      issueProjectId,
      issueProjectPath,
      issueIid: created.issue.iid,
      codeProjectId,
      codeProjectPath,
      targetBranch,
      branchName: args.branch_name?.trim() || created.parsed.branch_name,
      englishSlug: args.english_slug?.trim(),
      workType: args.work_type,
      summary: args.summary ?? created.parsed.summary,
      commitMessage: args.commit_message?.trim(),
      commitActions,
      changeSummary: args.change_summary,
      testPlan: args.test_plan,
      label: optionalStringParam(args.label, config.defaults.label),
      assigneeUsername: optionalStringParam(args.assignee_username, config.defaults.assigneeUsername),
      checkoutLocalBranch: args.checkout_local_branch ?? config.defaults.checkoutLocalBranch,
      issueCommentBody: args.issue_comment_body,
      implementationSummary: args.implementation_summary,
      acceptanceSteps: args.acceptance_steps,
      updateLog: args.update_log ?? config.defaults.updateIssueLog,
      logPath: args.log_path,
      logStatus: args.log_status,
    });

    await deleteDeliveryPreparationRecord(
      getDeliveryPreparationStatePath(),
      preparation.preparationKey,
    );

    return {
      created_issue: created.issue,
      parsed: created.parsed,
      delivery,
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
      project_id: z.number().int().positive().optional().describe(anyProjectEnvBackedDescription("GitLab project ID.")),
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
    const projectId = requireAnyProjectIdParam("gitlab_list_labels", "project_id", args.project_id);
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
      project_id: z.number().int().positive().optional().describe(anyProjectEnvBackedDescription("GitLab project ID.")),
      name: z.string().optional().describe("Label name."),
      color: z.string().optional().describe("Label color, e.g. #FF8800."),
      description: z.string().optional().describe("Label description."),
      priority: z.number().int().positive().optional().describe("Label priority."),
    },
  },
  withToolErrorHandling("gitlab_create_label", async (args) => {
    const projectId = requireAnyProjectIdParam("gitlab_create_label", "project_id", args.project_id);
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
      project_id: z.number().int().positive().optional().describe(anyProjectEnvBackedDescription("GitLab project ID.")),
      name: z.string().optional().describe("Existing label name."),
      new_name: z.string().optional().describe("New label name."),
      color: z.string().optional().describe("New color, e.g. #00AAFF."),
      description: z.string().optional().describe("New label description."),
      priority: z.number().int().positive().optional().describe("New label priority."),
    },
  },
  withToolErrorHandling("gitlab_update_label", async (args) => {
    const projectId = requireAnyProjectIdParam("gitlab_update_label", "project_id", args.project_id);
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
      project_id: z.number().int().positive().optional().describe(anyProjectEnvBackedDescription("GitLab project ID.")),
      label_name: z.string().optional().describe("Label name to delete."),
    },
  },
  withToolErrorHandling("gitlab_delete_label", async (args) => {
    const projectId = requireAnyProjectIdParam("gitlab_delete_label", "project_id", args.project_id);
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
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_ISSUE_PROJECT_ID")),
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
    const projectId = requireIssueProjectIdParam("gitlab_create_issue", "project_id", args.project_id);
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
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
    },
  },
  withToolErrorHandling("gitlab_get_merge_request", async (args) => {
    const projectId = requireCodeProjectIdParam("gitlab_get_merge_request", "project_id", args.project_id);
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
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
      sort: z.enum(["asc", "desc"]).optional().describe("Sort order."),
      order_by: z
        .enum(["created_at", "updated_at"])
        .optional()
        .describe("Field used for ordering."),
    },
  },
  withToolErrorHandling("gitlab_get_mr_notes", async (args) => {
    const projectId = requireCodeProjectIdParam("gitlab_get_mr_notes", "project_id", args.project_id);
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
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_ISSUE_PROJECT_ID")),
      issue_iid: z.number().int().positive().optional().describe("Issue IID (internal ID)."),
    },
  },
  withToolErrorHandling("gitlab_get_issue", async (args) => {
    const projectId = requireIssueProjectIdParam("gitlab_get_issue", "project_id", args.project_id);
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
      project_id: z.number().int().positive().optional().describe(anyProjectEnvBackedDescription("GitLab project ID.")),
      filename: z.string().optional().describe("Original file name."),
      content_base64: z.string().optional().describe("File content encoded in base64."),
      content_type: z
        .string()
        .optional()
        .describe("Optional MIME type, e.g. image/png."),
    },
  },
  withToolErrorHandling("gitlab_upload_project_file", async (args) => {
    const projectId = requireAnyProjectIdParam("gitlab_upload_project_file", "project_id", args.project_id);
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
      "Extract image references from issue description/notes. When include_base64=true, download each image, return base64 metadata, and attach MCP image content blocks so the model can inspect the image itself.",
    outputSchema: gitlabGetIssueImagesOutputSchema,
    inputSchema: {
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_ISSUE_PROJECT_ID")),
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
  async (args) => {
    try {
      const projectId = requireIssueProjectIdParam("gitlab_get_issue_images", "project_id", args.project_id);
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
          resolved_url: gitlab.resolveProjectUploadWebUrl(projectId, imageRef.rawUrl),
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
              resolved_url: gitlab.resolveProjectUploadWebUrl(projectId, imageRef.rawUrl),
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

      const imageContentBlocks: ToolImageContent[] = [];
      if (includeBase64) {
        for (const imageRow of dedupedRows) {
          const rawUrl = imageRow.raw_url;
          if (typeof rawUrl !== "string") {
            continue;
          }
          try {
            const download = await gitlab.downloadBinaryAsBase64(rawUrl, { projectId });
            imageRow.content_type = download.content_type;
            imageRow.size_bytes = download.size_bytes;
            imageRow.base64 = download.base64;
            imageRow.resolved_url = download.resolved_url;

            if (download.content_type?.startsWith("image/")) {
              imageContentBlocks.push({
                type: "image",
                data: download.base64,
                mimeType: download.content_type,
              });
            }
          } catch (error) {
            imageRow.fetch_error =
              error instanceof Error ? error.message : String(error);
          }
        }
      }

      const payload = {
        issue_iid: issueIid,
        issue_web_url: typeof issue.web_url === "string" ? issue.web_url : undefined,
        image_count: dedupedRows.length,
        images: dedupedRows,
      };

      return contentResult(payload, imageContentBlocks);
    } catch (error) {
      return textResult(toErrorPayload("gitlab_get_issue_images", error));
    }
  },
);

server.registerTool(
  "gitlab_get_issue_notes",
  {
    description: "Get issue notes/comments by project_id + issue_iid.",
    outputSchema: gitlabGetIssueNotesOutputSchema,
    inputSchema: {
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_ISSUE_PROJECT_ID")),
      issue_iid: z.number().int().positive().optional().describe("Issue IID (internal ID)."),
      sort: z.enum(["asc", "desc"]).optional().describe("Sort order."),
      order_by: z
        .enum(["created_at", "updated_at"])
        .optional()
        .describe("Field used for ordering."),
    },
  },
  withToolErrorHandling("gitlab_get_issue_notes", async (args) => {
    const projectId = requireIssueProjectIdParam("gitlab_get_issue_notes", "project_id", args.project_id);
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
    description:
      "Create issue note/comment. Supports direct body or auto-generation from MR changed files (by MR IID or source branch).",
    outputSchema: gitlabAddIssueCommentOutputSchema,
    inputSchema: {
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_ISSUE_PROJECT_ID")),
      issue_iid: z.number().int().positive().optional().describe("Issue IID."),
      body: z
        .string()
        .optional()
        .describe("Comment markdown body. If provided, auto-generation fields are ignored."),
      auto_generate_from_mr_changes: z
        .boolean()
        .optional()
        .describe("When true and body is missing, generate comment from MR changed-file analysis."),
      code_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          envBackedDescription(
            "Code project ID used for MR lookup/changes when auto_generate_from_mr_changes=true.",
            "WORKFLOW_CODE_PROJECT_ID",
          ),
        ),
      mr_iid: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional MR IID for changed-file analysis."),
      branch_name: z
        .string()
        .optional()
        .describe("Optional source branch for MR lookup when mr_iid is not provided."),
      target_branch: z
        .string()
        .optional()
        .describe("Optional target branch filter while resolving MR by branch_name."),
      local_repo_path: z
        .string()
        .optional()
        .describe("Optional local repo path used to detect current branch when branch_name is missing."),
      include_issue_context: z
        .boolean()
        .optional()
        .describe("Whether generated comment includes compact issue requirement context. Default true."),
      max_changed_files: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Maximum number of changed files included in generated comment. Default 30."),
    },
  },
  withToolErrorHandling("gitlab_add_issue_comment", async (args) => {
    const projectId = requireIssueProjectIdParam("gitlab_add_issue_comment", "project_id", args.project_id);
    const issueIid = requireNumberParam("gitlab_add_issue_comment", "issue_iid", args.issue_iid, undefined);
    enforceIssueProjectLock("gitlab_add_issue_comment", projectId);

    let body = args.body?.trim();
    const autoGenerate = args.auto_generate_from_mr_changes ?? false;
    let generatedFromMr:
      | {
          code_project_id: number;
          mr_iid: number;
          source_branch?: string;
          target_branch?: string;
          changed_files: string[];
        }
      | undefined;

    if (!body && autoGenerate) {
      const codeProjectId = requireNumberParam(
        "gitlab_add_issue_comment",
        "code_project_id",
        args.code_project_id,
        config.defaults.codeProjectId,
        "WORKFLOW_CODE_PROJECT_ID",
      );
      enforceCodeProjectLock("gitlab_add_issue_comment", codeProjectId);

      const issue = await gitlab.getIssue(projectId, issueIid);
      const includeIssueContext = args.include_issue_context ?? true;
      const maxChangedFiles =
        ensurePositiveIntRangeOptional(
          "gitlab_add_issue_comment",
          "max_changed_files",
          args.max_changed_files,
          100,
        ) ?? 30;

      let mrIid = ensurePositiveIntOptional("gitlab_add_issue_comment", "mr_iid", args.mr_iid);
      let sourceBranch = args.branch_name?.trim();

      if (!mrIid) {
        sourceBranch = await resolveBranchNameForAutoIssueComment({
          toolName: "gitlab_add_issue_comment",
          branchName: args.branch_name,
          localRepoPath: args.local_repo_path,
        });

        const mergeRequests = await gitlab.listMergeRequests(codeProjectId, {
          state: "opened",
          sourceBranch,
          targetBranch: args.target_branch?.trim(),
          orderBy: "updated_at",
          sort: "desc",
          page: 1,
          perPage: 20,
        });

        const matchedMr = (mergeRequests as any[]).find(
          (item) => Number.isInteger(item?.iid) && item.iid > 0,
        );
        if (!matchedMr) {
          throw new ToolInputError(
            `[gitlab_add_issue_comment] No opened merge request found in code_project_id=${codeProjectId} for source branch '${sourceBranch}'. Provide 'mr_iid' explicitly or verify branch/target_branch.`,
          );
        }
        mrIid = matchedMr.iid;
        if (typeof matchedMr?.source_branch === "string" && matchedMr.source_branch.trim()) {
          sourceBranch = matchedMr.source_branch.trim();
        }
      }

      const resolvedMrIid = mrIid;
      if (!resolvedMrIid) {
        throw new ToolInputError(
          "[gitlab_add_issue_comment] Failed to resolve merge request for auto-generated comment.",
        );
      }

      const mrChanges = await gitlab.getMergeRequestChanges(codeProjectId, resolvedMrIid);
      if (!sourceBranch && typeof mrChanges?.source_branch === "string") {
        sourceBranch = mrChanges.source_branch.trim();
      }
      const targetBranch =
        args.target_branch?.trim() ||
        (typeof mrChanges?.target_branch === "string" ? mrChanges.target_branch.trim() : undefined);
      const changedFiles = extractChangedFilePaths(mrChanges, maxChangedFiles);

      body = buildIssueCommentFromMrChanges({
        issueIid,
        issueTitle:
          typeof issue?.title === "string" && issue.title.trim()
            ? issue.title.trim()
            : `Issue ${issueIid}`,
        issueDescription: typeof issue?.description === "string" ? issue.description : undefined,
        codeProjectId,
        mrIid: resolvedMrIid,
        sourceBranch,
        targetBranch,
        changedFiles,
        includeIssueContext,
      });

      generatedFromMr = {
        code_project_id: codeProjectId,
        mr_iid: resolvedMrIid,
        source_branch: sourceBranch,
        target_branch: targetBranch,
        changed_files: changedFiles,
      };
    }

    if (!body) {
      throw new ToolInputError(
        "[gitlab_add_issue_comment] Missing required parameter 'body'. Provide 'body', or set auto_generate_from_mr_changes=true with code_project_id plus mr_iid or branch_name (or explicit local_repo_path).",
      );
    }

    const note = await gitlab.createIssueNote(projectId, issueIid, body);
    if (!generatedFromMr) {
      return note;
    }
    return {
      ...note,
      generated_from_mr_changes: generatedFromMr,
    };
  }),
);

server.registerTool(
  "gitlab_create_branch",
  {
    description: "Create repository branch by GitLab REST API.",
    outputSchema: gitlabCreateBranchOutputSchema,
    inputSchema: {
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      branch: z.string().optional().describe("Branch name to create."),
      ref: z.string().optional().describe("Source ref (branch/tag/SHA)."),
    },
  },
  withToolErrorHandling("gitlab_create_branch", async (args) => {
    const projectId = requireCodeProjectIdParam("gitlab_create_branch", "project_id", args.project_id);
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
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      file_path: z.string().optional().describe("Repository file path."),
      ref: z
        .string()
        .optional()
        .describe("Branch/tag/SHA to read. Optional; when omitted GitLab HEAD is used."),
    },
  },
  withToolErrorHandling("gitlab_get_file", async (args) => {
    const projectId = requireCodeProjectIdParam("gitlab_get_file", "project_id", args.project_id);
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
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_CODE_PROJECT_ID")),
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
    const projectId = requireCodeProjectIdParam("gitlab_commit_files", "project_id", args.project_id);
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
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      source_branch: z.string().optional().describe("Source branch."),
      target_branch: z.string().optional().describe("Target branch."),
      title: z.string().optional().describe("Merge request title."),
      description: z.string().optional().describe("Merge request description."),
      issue_project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          envBackedDescription(
            "Optional issue project ID used to render related issue reference in MR description.",
            "WORKFLOW_ISSUE_PROJECT_ID",
          ),
        ),
      issue_project_path: z
        .string()
        .optional()
        .describe(
          envBackedDescription(
            "Optional issue project path used to render related issue reference.",
            "WORKFLOW_ISSUE_PROJECT_PATH",
          ),
        ),
      issue_iid: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional related issue IID. If provided, MR description will include related issue section."),
      labels: z.array(z.string()).optional().describe("Labels array."),
      assignee_ids: z.array(z.number().int().positive()).optional().describe("Assignee user IDs."),
      reviewer_ids: z.array(z.number().int().positive()).optional().describe("Reviewer user IDs."),
      remove_source_branch: z.boolean().optional().describe("Remove source branch after merge."),
      squash: z.boolean().optional().describe("Enable squash on merge."),
      draft: z.boolean().optional().describe("Create MR as draft."),
    },
  },
  withToolErrorHandling("gitlab_create_merge_request", async (args) => {
    const projectId = requireCodeProjectIdParam("gitlab_create_merge_request", "project_id", args.project_id);
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
    const issueProjectId =
      ensurePositiveIntOptional("gitlab_create_merge_request", "issue_project_id", args.issue_project_id) ??
      config.defaults.issueProjectId;
    const issueProjectPath = optionalStringParam(args.issue_project_path, config.defaults.issueProjectPath);
    const issueIid = ensurePositiveIntOptional("gitlab_create_merge_request", "issue_iid", args.issue_iid);

    if ((issueProjectId !== undefined || issueProjectPath) && issueIid === undefined) {
      missingParam("gitlab_create_merge_request", "issue_iid");
    }
    if (issueIid !== undefined && issueProjectId === undefined && !issueProjectPath) {
      invalidParam(
        "gitlab_create_merge_request",
        "issue_iid",
        "requires issue_project_id or issue_project_path to build issue reference",
      );
    }
    if (issueProjectId !== undefined) {
      enforceAnyLockedProject("gitlab_create_merge_request", issueProjectId);
    }

    const mergedDescription = withIssueReferenceInMrDescription({
      description: args.description,
      issueIid,
      issueProjectId,
      issueProjectPath,
    });

    enforceCodeProjectLock("gitlab_create_merge_request", projectId);
    return gitlab.createMergeRequest({
      projectId,
      sourceBranch,
      targetBranch,
      title,
      description: mergedDescription,
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
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
      body: z.string().optional().describe("Comment markdown body."),
    },
  },
  withToolErrorHandling("gitlab_create_mr_note", async (args) => {
    const projectId = requireCodeProjectIdParam("gitlab_create_mr_note", "project_id", args.project_id);
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
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
    },
  },
  withToolErrorHandling("gitlab_get_mr_changes", async (args) => {
    const projectId = requireCodeProjectIdParam("gitlab_get_mr_changes", "project_id", args.project_id);
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
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
      sha: z
        .string()
        .optional()
        .describe("Optional expected HEAD SHA for optimistic locking during approval."),
    },
  },
  withToolErrorHandling("gitlab_approve_mr", async (args) => {
    const projectId = requireCodeProjectIdParam("gitlab_approve_mr", "project_id", args.project_id);
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
      project_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(envBackedDescription("GitLab project ID.", "WORKFLOW_CODE_PROJECT_ID")),
      mr_iid: z.number().int().positive().optional().describe("Merge request IID."),
    },
  },
  withToolErrorHandling("gitlab_unapprove_mr", async (args) => {
    const projectId = requireCodeProjectIdParam("gitlab_unapprove_mr", "project_id", args.project_id);
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
