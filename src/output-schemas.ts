import { z } from "zod";

export const standardToolOutputSchema = {
  ok: z.boolean().describe("Whether the tool call succeeded."),
  tool: z.string().describe("Tool name."),
  data: z.unknown().optional().describe("Tool result payload when ok=true."),
  error_type: z
    .enum(["input_error", "runtime_error", "unknown_error"])
    .optional()
    .describe("Error type when ok=false."),
  message: z.string().optional().describe("Error message when ok=false."),
};

function createToolOutputSchema(dataSchema: z.ZodTypeAny, dataDescription: string) {
  return {
    ...standardToolOutputSchema,
    data: dataSchema.optional().describe(dataDescription),
  };
}

const workflowParseRequirementDataSchema = z.object({
  work_type: z.string().describe("Detected work type / branch prefix."),
  commit_type: z.string().describe("Suggested commit type / branch prefix."),
  summary: z.string().describe("Short requirement summary."),
  issue_title: z.string().describe("Generated issue title."),
  branch_name: z.string().describe("Suggested git branch name."),
});

const issueBriefSchema = z.object({
  id: z.number().describe("Issue global ID."),
  iid: z.number().describe("Issue IID in the project."),
  web_url: z.string().describe("Issue web URL."),
});

const branchBriefSchema = z.object({
  name: z.string().describe("Branch name."),
  web_url: z.string().optional().describe("Branch web URL."),
});

const logUpdateSchema = z.object({
  updated: z.boolean().describe("Whether log file was updated."),
  path: z.string().optional().describe("Absolute local log file path."),
});

const mergeRequestBriefSchema = z.object({
  id: z.number().describe("Merge request global ID."),
  iid: z.number().describe("Merge request IID in project."),
  title: z.string().describe("Merge request title."),
  web_url: z.string().describe("Merge request web URL."),
});

const workflowAppendIssueLogDataSchema = logUpdateSchema;

const workflowAnalyzeAndCreateIssueDataSchema = z.object({
  parsed: workflowParseRequirementDataSchema.describe("Parsed requirement metadata."),
  issue: issueBriefSchema.describe("Created issue metadata."),
});

const workflowReviewMrAndCommentDataSchema = z.object({
  mode: z.enum(["prepared", "posted"]).describe("Whether the tool prepared review context or posted a comment."),
  merge_request: mergeRequestBriefSchema.describe("Target merge request metadata."),
  prepared_review: z
    .object({
      review_prompt: z.string().describe("Concise prompt text for an external LLM reviewer."),
      changed_files: z.array(z.string()).describe("Changed file paths included in review context."),
      diffs: z.array(
        z.object({
          old_path: z.string().optional().describe("Previous file path."),
          new_path: z.string().optional().describe("Current file path."),
          diff: z.string().describe("Unified diff content for this file."),
          new_file: z.boolean().optional().describe("Whether this file is newly created."),
          renamed_file: z.boolean().optional().describe("Whether this file was renamed."),
          deleted_file: z.boolean().optional().describe("Whether this file was deleted."),
          diff_truncated: z.boolean().optional().describe("Whether diff content was truncated."),
        }),
      ).describe("Prepared diff payload for LLM review."),
      existing_notes_count: z.number().optional().describe("Existing MR notes count when loaded."),
    })
    .optional()
    .describe("Prepared MR review context for an external LLM."),
  review_note: z
    .object({
      note_id: z.number().describe("Created review note ID."),
      body: z.string().describe("Review note markdown body."),
      web_url: z.string().nullable().describe("MR/note URL when available."),
    })
    .optional()
    .describe("Review comment result."),
  approval: z
    .object({
      approved: z.boolean().describe("Whether approval action was executed."),
      response: z.unknown().optional().describe("Raw GitLab approval response."),
    })
    .optional()
    .describe("Approval execution result when requested."),
});

const workflowLocalSyncCheckoutBranchDataSchema = z.object({
  repo_path: z.string().describe("Absolute local repository path."),
  remote_name: z.string().describe("Git remote name used for synchronization."),
  branch_name: z.string().describe("Checked-out branch name."),
  commands: z.array(z.string()).describe("Executed git commands."),
  current_branch: z.string().describe("Current local branch after execution."),
  head_sha: z.string().describe("HEAD commit SHA after checkout."),
});

const workflowPrepareDeliveryWorkspaceDataSchema = z.object({
  repo_path: z.string().describe("Absolute local repository path."),
  remote_name: z.string().describe("Git remote name used for synchronization."),
  delivery_method: z.enum(["local_git", "remote_api"]).describe("Delivery method prepared for subsequent workflows."),
  base_branch: z.string().describe("Base branch refreshed before code generation."),
  working_branch: z.string().optional().describe("Prepared local working branch when delivery_method=local_git."),
  current_branch: z.string().describe("Current local branch after preparation."),
  base_head_sha: z.string().describe("Prepared local/remote HEAD SHA for the base branch."),
  commands: z.array(z.string()).describe("Executed git commands."),
  preparation_key: z.string().describe("Server-issued key required by delivery workflows."),
  prepared_at: z.string().describe("Preparation timestamp in ISO-8601 format."),
  expires_at: z.string().describe("Preparation expiry timestamp in ISO-8601 format."),
});

const workflowIssueToMrFullDataSchema = z.object({
  issue: issueBriefSchema.describe("Related issue metadata."),
  branch: branchBriefSchema.describe("Created/used branch metadata."),
  commit: z
    .object({
      id: z.unknown().optional().describe("Commit SHA."),
      short_id: z.unknown().optional().describe("Short commit SHA."),
      title: z.unknown().optional().describe("Commit title."),
      web_url: z.unknown().optional().describe("Commit URL."),
    })
    .describe("Commit result payload."),
  merge_request: mergeRequestBriefSchema.describe("Created merge request metadata."),
  issue_comment: z
    .object({
      note_id: z.number().describe("Created issue note ID."),
      body: z.string().describe("Issue note markdown body."),
      web_url: z.string().nullable().describe("Issue note URL when available."),
    })
    .describe("Issue comment result."),
  local_checkout: workflowLocalSyncCheckoutBranchDataSchema
    .optional()
    .describe("Optional local checkout result."),
  log: logUpdateSchema.describe("Issue log update result."),
});

const workflowRequirementToDeliveryFullDataSchema = z.object({
  created_issue: issueBriefSchema.describe("Issue created from requirement."),
  parsed: workflowParseRequirementDataSchema.describe("Requirement parsing result."),
  delivery: workflowIssueToMrFullDataSchema.describe("Delivery workflow result."),
});

const gitlabIssueSchema = z
  .object({
    id: z.number().describe("Issue global ID."),
    iid: z.number().describe("Issue IID in project."),
    title: z.unknown().optional().describe("Issue title (type may vary across instances)."),
    description: z.unknown().optional().describe("Issue description payload."),
    state: z.unknown().optional().describe("Issue state."),
    web_url: z.unknown().optional().describe("Issue web URL."),
  })
  .passthrough();

const gitlabNoteSchema = z
  .object({
    id: z.number().describe("Note ID."),
    body: z.unknown().optional().describe("Note markdown body."),
    created_at: z.unknown().optional().describe("Creation timestamp."),
    updated_at: z.unknown().optional().describe("Update timestamp."),
    system: z.unknown().optional().describe("Whether note is system-generated."),
  })
  .passthrough();

const gitlabBranchSchema = z
  .object({
    name: z.string().describe("Branch name."),
    merged: z.unknown().optional().describe("Whether branch is merged."),
    protected: z.unknown().optional().describe("Whether branch is protected."),
    default: z.unknown().optional().describe("Whether branch is default branch."),
    web_url: z.unknown().optional().describe("Branch web URL."),
  })
  .passthrough();

const gitlabFileSchema = z
  .object({
    file_name: z.unknown().optional().describe("File name."),
    file_path: z.unknown().optional().describe("Repository file path."),
    size: z.unknown().optional().describe("File size in bytes."),
    encoding: z.unknown().optional().describe("Content encoding."),
    content: z.unknown().optional().describe("Raw encoded content from GitLab."),
    decoded_content: z.unknown().optional().describe("Decoded content."),
    ref: z.unknown().optional().describe("Requested ref."),
    blob_id: z.unknown().optional().describe("Blob SHA."),
    commit_id: z.unknown().optional().describe("Commit SHA."),
    last_commit_id: z.unknown().optional().describe("Last commit SHA for file."),
  })
  .passthrough();

const gitlabCommitSchema = z
  .object({
    id: z.unknown().optional().describe("Commit SHA."),
    short_id: z.unknown().optional().describe("Short commit SHA."),
    title: z.unknown().optional().describe("Commit title."),
    message: z.unknown().optional().describe("Commit message."),
    web_url: z.unknown().optional().describe("Commit web URL."),
    created_at: z.unknown().optional().describe("Commit timestamp."),
  })
  .passthrough();

const gitlabMergeRequestSchema = z
  .object({
    id: z.number().describe("Merge request global ID."),
    iid: z.number().describe("Merge request IID in project."),
    title: z.unknown().describe("Merge request title."),
    web_url: z.unknown().optional().describe("Merge request web URL."),
    state: z.unknown().optional().describe("Merge request state."),
    source_branch: z.unknown().optional().describe("Source branch."),
    target_branch: z.unknown().optional().describe("Target branch."),
  })
  .passthrough();

const gitlabMergeRequestChangesSchema = z
  .object({
    id: z.unknown().optional().describe("Merge request global ID."),
    iid: z.unknown().optional().describe("Merge request IID."),
    changes: z
      .array(
        z
          .object({
            old_path: z.unknown().optional().describe("Old file path."),
            new_path: z.unknown().optional().describe("New file path."),
            diff: z.unknown().optional().describe("Unified diff patch."),
            new_file: z.unknown().optional().describe("Whether file is newly created."),
            renamed_file: z.unknown().optional().describe("Whether file is renamed."),
            deleted_file: z.unknown().optional().describe("Whether file is deleted."),
          })
          .passthrough(),
      )
      .optional()
      .describe("Changed files list."),
  })
  .passthrough();

const gitlabApprovalSchema = z
  .object({
    id: z.unknown().optional().describe("Merge request global ID."),
    iid: z.unknown().optional().describe("Merge request IID."),
    approved: z.unknown().optional().describe("Whether current user approved."),
    approvals_required: z.unknown().optional().describe("Approvals required."),
    approvals_left: z.unknown().optional().describe("Approvals left."),
  })
  .passthrough();

const gitlabUserSchema = z
  .object({
    id: z.number().describe("User ID."),
    username: z.unknown().optional().describe("GitLab username."),
    name: z.unknown().optional().describe("Display name."),
    state: z.unknown().optional().describe("Account state."),
    web_url: z.unknown().optional().describe("Profile URL."),
  })
  .passthrough();

const gitlabLabelSchema = z
  .object({
    id: z.unknown().optional().describe("Label ID."),
    name: z.unknown().optional().describe("Label name."),
    color: z.unknown().optional().describe("Label color hex."),
    text_color: z.unknown().optional().describe("Label text color."),
    description: z.unknown().optional().describe("Label description."),
    priority: z.unknown().optional().describe("Label priority."),
    is_project_label: z.unknown().optional().describe("Whether this is a project-scoped label."),
  })
  .passthrough();

const gitlabDeleteLabelSchema = z.object({
  deleted: z.boolean().describe("Whether label delete call completed."),
  label_name: z.string().describe("Deleted label name."),
  project_id: z.number().describe("Target project ID."),
});

const gitlabUploadProjectFileSchema = z
  .object({
    id: z.unknown().optional().describe("Upload ID if provided by GitLab."),
    alt: z.unknown().optional().describe("Uploaded file alt text."),
    url: z.unknown().optional().describe("Relative upload URL."),
    full_path: z.unknown().optional().describe("Full web path of uploaded asset."),
    markdown: z.unknown().optional().describe("Markdown snippet referencing uploaded file."),
  })
  .passthrough();

const issueImageItemSchema = z.object({
  source: z.enum(["issue_description", "issue_note"]).describe("Where the image reference was found."),
  note_id: z.number().optional().describe("Issue note ID when source is issue_note."),
  note_created_at: z.string().optional().describe("Issue note creation timestamp."),
  alt_text: z.string().optional().describe("Image alt text."),
  raw_url: z.string().describe("Raw URL/path parsed from markdown or HTML."),
  resolved_url: z.string().describe("Absolute URL resolved against GitLab host."),
  markdown_fragment: z.string().describe("Original markdown/html fragment containing the image link."),
  content_type: z.string().optional().describe("Downloaded image content type."),
  size_bytes: z.number().optional().describe("Downloaded byte size."),
  base64: z.string().optional().describe("Image base64 content when include_base64=true."),
  fetch_error: z.string().optional().describe("Download error message for this image."),
});

const gitlabIssueImagesSchema = z.object({
  issue_iid: z.number().describe("Issue IID."),
  issue_web_url: z.string().optional().describe("Issue web URL."),
  image_count: z.number().describe("Total parsed image references."),
  images: z.array(issueImageItemSchema).describe("Parsed image references."),
});

const gitlabAddIssueCommentDataSchema = z
  .object({
    id: z.number().describe("Note ID."),
    body: z.unknown().optional().describe("Note markdown body."),
    created_at: z.unknown().optional().describe("Creation timestamp."),
    updated_at: z.unknown().optional().describe("Update timestamp."),
    system: z.unknown().optional().describe("Whether note is system-generated."),
    generated_from_mr_changes: z
      .object({
        code_project_id: z.number().describe("Code project ID used for MR changes analysis."),
        mr_iid: z.number().describe("Merge request IID used for analysis."),
        source_branch: z.string().optional().describe("Resolved source branch."),
        target_branch: z.string().optional().describe("Resolved target branch."),
        changed_files: z.array(z.string()).describe("Changed files included in generated comment."),
      })
      .optional()
      .describe("Auto-generation metadata when comment body is derived from MR changes."),
  })
  .passthrough();

export const workflowAppendIssueLogOutputSchema = createToolOutputSchema(
  workflowAppendIssueLogDataSchema,
  "Issue log append result.",
);
export const workflowAnalyzeAndCreateIssueOutputSchema = createToolOutputSchema(
  workflowAnalyzeAndCreateIssueDataSchema,
  "Analyze requirement and create issue workflow result.",
);
export const workflowReviewMrAndCommentOutputSchema = createToolOutputSchema(
  workflowReviewMrAndCommentDataSchema,
  "Review merge request and create comment workflow result.",
);
export const workflowLocalSyncCheckoutBranchOutputSchema = createToolOutputSchema(
  workflowLocalSyncCheckoutBranchDataSchema,
  "Local repository sync and branch checkout result.",
);
export const workflowPrepareDeliveryWorkspaceOutputSchema = createToolOutputSchema(
  workflowPrepareDeliveryWorkspaceDataSchema,
  "Prepared local workspace state used to generate delivery commit_actions.",
);
export const workflowIssueToMrFullOutputSchema = createToolOutputSchema(
  workflowIssueToMrFullDataSchema,
  "Issue to MR full-chain workflow result.",
);
export const workflowRequirementToDeliveryFullOutputSchema = createToolOutputSchema(
  workflowRequirementToDeliveryFullDataSchema,
  "Requirement to delivery full workflow result.",
);

export const gitlabCreateIssueOutputSchema = createToolOutputSchema(
  gitlabIssueSchema,
  "Created GitLab issue payload.",
);
export const gitlabGetIssueOutputSchema = createToolOutputSchema(
  gitlabIssueSchema,
  "GitLab issue payload.",
);
export const gitlabGetIssueNotesOutputSchema = createToolOutputSchema(
  z.array(gitlabNoteSchema),
  "GitLab issue notes list.",
);
export const gitlabAddIssueCommentOutputSchema = createToolOutputSchema(
  gitlabAddIssueCommentDataSchema,
  "Created GitLab issue note payload.",
);
export const gitlabCreateBranchOutputSchema = createToolOutputSchema(
  gitlabBranchSchema,
  "Created GitLab branch payload.",
);
export const gitlabGetFileOutputSchema = createToolOutputSchema(
  gitlabFileSchema,
  "GitLab file payload with decoded content.",
);
export const gitlabCommitFilesOutputSchema = createToolOutputSchema(
  gitlabCommitSchema,
  "Created GitLab commit payload.",
);
export const gitlabCreateMergeRequestOutputSchema = createToolOutputSchema(
  gitlabMergeRequestSchema,
  "Created GitLab merge request payload.",
);
export const gitlabCreateMrNoteOutputSchema = createToolOutputSchema(
  gitlabNoteSchema,
  "Created GitLab merge request note payload.",
);
export const gitlabGetMrChangesOutputSchema = createToolOutputSchema(
  gitlabMergeRequestChangesSchema,
  "GitLab merge request changes payload.",
);
export const gitlabApproveMrOutputSchema = createToolOutputSchema(
  gitlabApprovalSchema,
  "GitLab merge request approval payload.",
);
export const gitlabUnapproveMrOutputSchema = createToolOutputSchema(
  gitlabApprovalSchema,
  "GitLab merge request unapproval payload.",
);
export const gitlabGetCurrentUserOutputSchema = createToolOutputSchema(
  gitlabUserSchema,
  "Current authenticated GitLab user payload.",
);
export const gitlabListLabelsOutputSchema = createToolOutputSchema(
  z.array(gitlabLabelSchema),
  "Label list payload for the target project.",
);
export const gitlabCreateLabelOutputSchema = createToolOutputSchema(
  gitlabLabelSchema,
  "Created label payload.",
);
export const gitlabUpdateLabelOutputSchema = createToolOutputSchema(
  gitlabLabelSchema,
  "Updated label payload.",
);
export const gitlabDeleteLabelOutputSchema = createToolOutputSchema(
  gitlabDeleteLabelSchema,
  "Label deletion result payload.",
);
export const gitlabGetMergeRequestOutputSchema = createToolOutputSchema(
  gitlabMergeRequestSchema,
  "Merge request detail payload.",
);
export const gitlabGetMrNotesOutputSchema = createToolOutputSchema(
  z.array(gitlabNoteSchema),
  "Merge request notes list payload.",
);
export const gitlabUploadProjectFileOutputSchema = createToolOutputSchema(
  gitlabUploadProjectFileSchema,
  "Project markdown upload payload.",
);
export const gitlabGetIssueImagesOutputSchema = createToolOutputSchema(
  gitlabIssueImagesSchema,
  "Parsed issue image references with optional base64 payloads.",
);
