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
  buildIssueDescription,
  buildIssueTitle,
  detectWorkType,
  renderIssueCompletionComment,
  renderIssueLogEntry,
  renderMergeRequestDescription,
  summarizeRequirement,
} from "./workflow.js";

const STATUS_IN_PROGRESS = "\u8fdb\u884c\u4e2d";
const STATUS_PENDING_REVIEW = "MR \u5f85\u5ba1\u67e5";
const FRONTEND_PREFIX_REGEX = /^\[\u524d\u7aef\]\s*/;

const config = getRuntimeConfig();
const gitlab = new GitLabClient({
  apiBaseUrl: config.gitlabApiBaseUrl,
  token: config.gitlabToken,
});

const server = new McpServer({
  name: "mcp-gitlab-workflow",
  version: "1.0.0",
});

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeSummaryFromIssueTitle(issueTitle: string): string {
  return issueTitle.replace(FRONTEND_PREFIX_REGEX, "").trim();
}

function inferWorkTypeFromBranch(branchName: string): WorkType {
  const prefix = branchName.split("/")[0];
  if (prefix === "fix" || prefix === "chore" || prefix === "feat") {
    return prefix;
  }
  return "feat";
}

async function resolveAssigneeId(username: string): Promise<number | undefined> {
  const assigneeId = await gitlab.findUserIdByUsername(username);
  return assigneeId ?? undefined;
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
  const statusLabel = "\u72b6\u6001";
  const fieldLabel = "\u5b57\u6bb5";
  const statusUpdateLabel = "\u72b6\u6001\u66f4\u65b0";

  const absolutePath = resolve(process.cwd(), params.logPath);
  await mkdir(dirname(absolutePath), { recursive: true });

  let content = "";
  try {
    content = await readFile(absolutePath, "utf8");
  } catch {
    content = "";
  }

  const issuePatternSource =
    "(## \\[[^\\]]+\\][\\s\\S]*?\\| Issue ID \\(iid\\) \\| `" +
    params.issueIid +
    "` \\|[\\s\\S]*?)(\\n\\*\\*[^\\n]+\\*\\*[:\\uff1a])";
  const issuePattern = new RegExp(issuePatternSource, "m");

  if (!issuePattern.test(content)) {
    const fallback = `\n## [${getTodayDateString()}] Issue ${params.issueIid} ${statusUpdateLabel}

| ${fieldLabel} | \u503c |
|------|-----|
| Issue ID (iid) | \`${params.issueIid}\` |
| MR ID | \`${params.mrIid}\` |
| MR URL | \`${params.mrUrl}\` |
| ${statusLabel} | ${params.status} |

---\n`;
    await writeFile(absolutePath, `${content}${fallback}`, "utf8");
    return absolutePath;
  }

  const statusRowRegex = new RegExp(`\\| ${statusLabel} \\| .*? \\|`);
  const updated = content.replace(issuePattern, (_full, sectionPrefix, marker) => {
    let section = sectionPrefix as string;

    if (!/\| MR ID \|/.test(section)) {
      section = section.replace(
        statusRowRegex,
        `| MR ID | \`${params.mrIid}\` |\n| MR URL | \`${params.mrUrl}\` |\n| ${statusLabel} | ${params.status} |`,
      );
    } else {
      section = section
        .replace(/\| MR ID \| .*? \|/, `| MR ID | \`${params.mrIid}\` |`)
        .replace(/\| MR URL \| .*? \|/, `| MR URL | \`${params.mrUrl}\` |`)
        .replace(statusRowRegex, `| ${statusLabel} | ${params.status} |`);
    }

    return `${section}${marker}`;
  });

  await writeFile(absolutePath, updated, "utf8");
  return absolutePath;
}

server.registerTool(
  "workflow_parse_requirement",
  {
    description: "Parse requirement text and return work_type, issue_title and branch_name",
    inputSchema: {
      requirement_text: z.string().min(1),
      english_slug: z.string().optional(),
      work_type: z.enum(["feat", "fix", "chore"]).optional(),
      summary: z.string().optional(),
    },
  },
  async ({ requirement_text, english_slug, work_type, summary }) => {
    const parsedWorkType = work_type ?? detectWorkType(requirement_text);
    const issueSummary = summary ?? summarizeRequirement(requirement_text, 30);
    const issueTitle = buildIssueTitle(issueSummary);
    const branchName = buildBranchName({
      workType: parsedWorkType,
      englishSlug: english_slug,
      requirementText: requirement_text,
    });

    return textResult({
      work_type: parsedWorkType,
      commit_type: parsedWorkType,
      summary: issueSummary,
      issue_title: issueTitle,
      branch_name: branchName,
    });
  },
);

server.registerTool(
  "workflow_start",
  {
    description:
      "Step 1-4: parse requirement, create issue in issue project, create branch in code project, append issue log",
    inputSchema: {
      requirement_text: z.string().min(1),
      source_text: z.string().optional(),
      expected_behavior: z.string().min(1),
      current_behavior: z.string().optional(),
      given: z.string().min(1),
      when: z.string().min(1),
      then: z.string().min(1),
      english_slug: z.string().optional(),
      work_type: z.enum(["feat", "fix", "chore"]).optional(),
      summary: z.string().optional(),
      append_log: z.boolean().default(true),
      log_path: z.string().optional(),
    },
  },
  async (args) => {
    const parsedWorkType = args.work_type ?? detectWorkType(args.requirement_text);
    const issueSummary = args.summary ?? summarizeRequirement(args.requirement_text, 30);
    const issueTitle = buildIssueTitle(issueSummary);
    const branchName = buildBranchName({
      workType: parsedWorkType,
      englishSlug: args.english_slug,
      requirementText: args.requirement_text,
    });

    const issueDescription = buildIssueDescription({
      sourceText: args.source_text ?? args.requirement_text,
      expectedBehavior: args.expected_behavior,
      currentBehavior: args.current_behavior,
      given: args.given,
      when: args.when,
      then: args.then,
      repoPath: config.defaults.codeProjectPath,
    });

    const assigneeId = await resolveAssigneeId(config.defaults.assigneeUsername);
    const issue = await gitlab.createIssue({
      projectId: config.defaults.issueProjectId,
      title: issueTitle,
      description: issueDescription,
      labels: [config.defaults.label],
      assigneeId,
    });

    const branch = await gitlab.createBranch(
      config.defaults.codeProjectId,
      branchName,
      config.defaults.baseBranch,
    );

    let logAbsolutePath: string | undefined;
    const shouldAppendLog = args.append_log ?? true;
    const logPath = args.log_path || config.defaults.issueLogPath;
    if (shouldAppendLog) {
      const logMarkdown = renderIssueLogEntry({
        date: getTodayDateString(),
        issueTitle,
        issueIid: issue.iid,
        issueProjectPath: config.defaults.issueProjectPath,
        issueProjectId: config.defaults.issueProjectId,
        issueWebUrl: issue.web_url,
        branchName,
        codeProjectPath: config.defaults.codeProjectPath,
        codeProjectId: config.defaults.codeProjectId,
        summary: issueSummary,
        status: STATUS_IN_PROGRESS,
      });
      logAbsolutePath = await appendMarkdown(logPath, logMarkdown);
    }

    return textResult({
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
      log: logAbsolutePath ? { updated: true, path: logAbsolutePath } : { updated: false },
      defaults: config.defaults,
    });
  },
);

server.registerTool(
  "workflow_append_issue_log",
  {
    description: "Append a workflow issue block into issue/log.md",
    inputSchema: {
      issue_title: z.string().min(1),
      issue_iid: z.number().int().positive(),
      issue_web_url: z.string().min(1),
      branch_name: z.string().min(1),
      summary: z.string().min(1),
      status: z.string().default(STATUS_IN_PROGRESS),
      log_path: z.string().optional(),
    },
  },
  async ({ issue_title, issue_iid, issue_web_url, branch_name, summary, status, log_path }) => {
    const markdown = renderIssueLogEntry({
      date: getTodayDateString(),
      issueTitle: issue_title,
      issueIid: issue_iid,
      issueProjectPath: config.defaults.issueProjectPath,
      issueProjectId: config.defaults.issueProjectId,
      issueWebUrl: issue_web_url,
      branchName: branch_name,
      codeProjectPath: config.defaults.codeProjectPath,
      codeProjectId: config.defaults.codeProjectId,
      summary,
      status,
    });

    const path = await appendMarkdown(log_path || config.defaults.issueLogPath, markdown);
    return textResult({ updated: true, path });
  },
);

server.registerTool(
  "workflow_add_issue_comment",
  {
    description: "Step 7: add completion comment into workflow issue",
    inputSchema: {
      issue_iid: z.number().int().positive(),
      changed_files: z.array(z.string()).default([]),
      branch_name: z.string().min(1),
      implementation_summary: z.string().min(1),
      acceptance_steps: z.string().min(1),
    },
  },
  async ({ issue_iid, changed_files, branch_name, implementation_summary, acceptance_steps }) => {
    const body = renderIssueCompletionComment({
      changedFiles: changed_files,
      branchName: branch_name,
      codeProjectPath: config.defaults.codeProjectPath,
      implementationSummary: implementation_summary,
      acceptanceSteps: acceptance_steps,
    });

    const note = await gitlab.createIssueNote(config.defaults.issueProjectId, issue_iid, body);
    return textResult({
      issue_iid,
      note_id: note.id,
      body,
      web_url: note?.noteable_url ?? null,
    });
  },
);

async function createWorkflowMergeRequest(params: {
  issueIid: number;
  branchName: string;
  changeSummary: string;
  testPlan: string;
  mergeRequestTitle?: string;
  workType?: WorkType;
  summary?: string;
}): Promise<any> {
  const issue = await gitlab.getIssue(config.defaults.issueProjectId, params.issueIid);
  const summary = params.summary ?? normalizeSummaryFromIssueTitle(issue.title ?? "");
  const workType = params.workType ?? inferWorkTypeFromBranch(params.branchName);
  const title = params.mergeRequestTitle || `${workType}: ${summary}`;
  const description = renderMergeRequestDescription({
    issueProjectPath: config.defaults.issueProjectPath,
    issueIid: params.issueIid,
    changeSummary: params.changeSummary,
    testPlan: params.testPlan,
  });

  const assigneeId = await resolveAssigneeId(config.defaults.assigneeUsername);
  return gitlab.createMergeRequest({
    projectId: config.defaults.codeProjectId,
    sourceBranch: params.branchName,
    targetBranch: config.defaults.targetBranch,
    title,
    description,
    labels: [config.defaults.label],
    assigneeId,
  });
}

server.registerTool(
  "workflow_create_merge_request",
  {
    description: "Step 8-9: create merge request and update issue log to pending review",
    inputSchema: {
      issue_iid: z.number().int().positive(),
      branch_name: z.string().min(1),
      change_summary: z.string().min(1),
      test_plan: z.string().min(1),
      merge_request_title: z.string().optional(),
      work_type: z.enum(["feat", "fix", "chore"]).optional(),
      summary: z.string().optional(),
      update_log: z.boolean().default(true),
      log_path: z.string().optional(),
      status: z.string().default(STATUS_PENDING_REVIEW),
    },
  },
  async ({
    issue_iid,
    branch_name,
    change_summary,
    test_plan,
    merge_request_title,
    work_type,
    summary,
    update_log,
    log_path,
    status,
  }) => {
    const mr = await createWorkflowMergeRequest({
      issueIid: issue_iid,
      branchName: branch_name,
      changeSummary: change_summary,
      testPlan: test_plan,
      mergeRequestTitle: merge_request_title,
      workType: work_type,
      summary,
    });

    let path: string | undefined;
    if (update_log ?? true) {
      path = await updateIssueLogWithMr({
        logPath: log_path || config.defaults.issueLogPath,
        issueIid: issue_iid,
        mrIid: mr.iid,
        mrUrl: mr.web_url,
        status,
      });
    }

    return textResult({
      merge_request: {
        id: mr.id,
        iid: mr.iid,
        title: mr.title,
        web_url: mr.web_url,
      },
      log: path ? { updated: true, path } : { updated: false },
    });
  },
);

server.registerTool(
  "workflow_complete",
  {
    description:
      "Step 7-9 combined: add issue comment, create merge request, and update issue/log.md",
    inputSchema: {
      issue_iid: z.number().int().positive(),
      branch_name: z.string().min(1),
      changed_files: z.array(z.string()).default([]),
      implementation_summary: z.string().min(1),
      acceptance_steps: z.string().min(1),
      change_summary: z.string().min(1),
      test_plan: z.string().min(1),
      merge_request_title: z.string().optional(),
      work_type: z.enum(["feat", "fix", "chore"]).optional(),
      summary: z.string().optional(),
      log_path: z.string().optional(),
      status: z.string().default(STATUS_PENDING_REVIEW),
    },
  },
  async ({
    issue_iid,
    branch_name,
    changed_files,
    implementation_summary,
    acceptance_steps,
    change_summary,
    test_plan,
    merge_request_title,
    work_type,
    summary,
    log_path,
    status,
  }) => {
    const issueNoteBody = renderIssueCompletionComment({
      changedFiles: changed_files,
      branchName: branch_name,
      codeProjectPath: config.defaults.codeProjectPath,
      implementationSummary: implementation_summary,
      acceptanceSteps: acceptance_steps,
    });
    const issueNote = await gitlab.createIssueNote(
      config.defaults.issueProjectId,
      issue_iid,
      issueNoteBody,
    );

    const mr = await createWorkflowMergeRequest({
      issueIid: issue_iid,
      branchName: branch_name,
      changeSummary: change_summary,
      testPlan: test_plan,
      mergeRequestTitle: merge_request_title,
      workType: work_type,
      summary,
    });

    const path = await updateIssueLogWithMr({
      logPath: log_path || config.defaults.issueLogPath,
      issueIid: issue_iid,
      mrIid: mr.iid,
      mrUrl: mr.web_url,
      status,
    });

    return textResult({
      issue_note: {
        id: issueNote.id,
      },
      merge_request: {
        id: mr.id,
        iid: mr.iid,
        title: mr.title,
        web_url: mr.web_url,
      },
      log: {
        updated: true,
        path,
      },
    });
  },
);

server.registerTool(
  "gitlab_create_issue",
  {
    description: "Create issue in GitLab project",
    inputSchema: {
      project_id: z.number().int().positive(),
      title: z.string().min(1),
      description: z.string().min(1),
      labels: z.array(z.string()).optional(),
      assignee_username: z.string().optional(),
    },
  },
  async ({ project_id, title, description, labels, assignee_username }) => {
    const assigneeId = assignee_username
      ? await resolveAssigneeId(assignee_username)
      : undefined;

    return textResult(
      await gitlab.createIssue({
        projectId: project_id,
        title,
        description,
        labels,
        assigneeId,
      }),
    );
  },
);

server.registerTool(
  "gitlab_get_issue",
  {
    description: "Get issue detail by project_id and issue_iid",
    inputSchema: {
      project_id: z.number().int().positive(),
      issue_iid: z.number().int().positive(),
    },
  },
  async ({ project_id, issue_iid }) => textResult(await gitlab.getIssue(project_id, issue_iid)),
);

server.registerTool(
  "gitlab_get_issue_notes",
  {
    description: "List issue comments by project_id and issue_iid",
    inputSchema: {
      project_id: z.number().int().positive(),
      issue_iid: z.number().int().positive(),
    },
  },
  async ({ project_id, issue_iid }) => textResult(await gitlab.getIssueNotes(project_id, issue_iid)),
);

server.registerTool(
  "gitlab_add_issue_comment",
  {
    description: "Create issue comment",
    inputSchema: {
      project_id: z.number().int().positive(),
      issue_iid: z.number().int().positive(),
      body: z.string().min(1),
    },
  },
  async ({ project_id, issue_iid, body }) =>
    textResult(await gitlab.createIssueNote(project_id, issue_iid, body)),
);

server.registerTool(
  "gitlab_create_branch",
  {
    description: "Create branch in GitLab repository",
    inputSchema: {
      project_id: z.number().int().positive(),
      branch: z.string().min(1),
      ref: z.string().default("HEAD"),
    },
  },
  async ({ project_id, branch, ref }) => textResult(await gitlab.createBranch(project_id, branch, ref)),
);

server.registerTool(
  "gitlab_get_file",
  {
    description: "Get repository file. Returns decoded_content if file content is base64",
    inputSchema: {
      project_id: z.number().int().positive(),
      file_path: z.string().min(1),
      ref: z.string().optional(),
    },
  },
  async ({ project_id, file_path, ref }) => textResult(await gitlab.getFile(project_id, file_path, ref)),
);

server.registerTool(
  "gitlab_commit_files",
  {
    description: "Create commit with multiple file actions (create/update/delete/move/chmod)",
    inputSchema: {
      project_id: z.number().int().positive(),
      branch: z.string().min(1),
      commit_message: z.string().min(1),
      start_branch: z.string().optional(),
      actions: z.array(
        z.object({
          action: z.enum(["create", "update", "delete", "move", "chmod"]),
          file_path: z.string().optional(),
          previous_path: z.string().optional(),
          content: z.string().optional(),
          encoding: z.enum(["text", "base64"]).optional(),
          execute_filemode: z.boolean().optional(),
          last_commit_id: z.string().optional(),
        }),
      ),
    },
  },
  async ({ project_id, branch, commit_message, start_branch, actions }) =>
    textResult(
      await gitlab.createCommit({
        projectId: project_id,
        branch,
        commitMessage: commit_message,
        startBranch: start_branch,
        actions: actions as CommitActionInput[],
      }),
    ),
);

server.registerTool(
  "gitlab_create_merge_request",
  {
    description: "Create merge request in GitLab project",
    inputSchema: {
      project_id: z.number().int().positive(),
      source_branch: z.string().min(1),
      target_branch: z.string().min(1),
      title: z.string().min(1),
      description: z.string().min(1),
      labels: z.array(z.string()).optional(),
      assignee_username: z.string().optional(),
      remove_source_branch: z.boolean().optional(),
    },
  },
  async ({
    project_id,
    source_branch,
    target_branch,
    title,
    description,
    labels,
    assignee_username,
    remove_source_branch,
  }) => {
    const assigneeId = assignee_username
      ? await resolveAssigneeId(assignee_username)
      : undefined;

    return textResult(
      await gitlab.createMergeRequest({
        projectId: project_id,
        sourceBranch: source_branch,
        targetBranch: target_branch,
        title,
        description,
        labels,
        assigneeId,
        removeSourceBranch: remove_source_branch,
      }),
    );
  },
);

server.registerTool(
  "gitlab_create_mr_note",
  {
    description: "Create merge request comment",
    inputSchema: {
      project_id: z.number().int().positive(),
      mr_iid: z.number().int().positive(),
      body: z.string().min(1),
    },
  },
  async ({ project_id, mr_iid, body }) =>
    textResult(await gitlab.createMergeRequestNote(project_id, mr_iid, body)),
);

server.registerTool(
  "gitlab_get_mr_changes",
  {
    description: "Get merge request changes for review",
    inputSchema: {
      project_id: z.number().int().positive(),
      mr_iid: z.number().int().positive(),
    },
  },
  async ({ project_id, mr_iid }) => textResult(await gitlab.getMergeRequestChanges(project_id, mr_iid)),
);

server.registerTool(
  "gitlab_approve_mr",
  {
    description: "Approve merge request",
    inputSchema: {
      project_id: z.number().int().positive(),
      mr_iid: z.number().int().positive(),
      sha: z.string().optional(),
    },
  },
  async ({ project_id, mr_iid, sha }) => textResult(await gitlab.approveMergeRequest(project_id, mr_iid, sha)),
);

server.registerTool(
  "gitlab_unapprove_mr",
  {
    description: "Unapprove merge request",
    inputSchema: {
      project_id: z.number().int().positive(),
      mr_iid: z.number().int().positive(),
    },
  },
  async ({ project_id, mr_iid }) => textResult(await gitlab.unapproveMergeRequest(project_id, mr_iid)),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
