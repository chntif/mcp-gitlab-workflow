export type WorkType = string;

export interface BranchNameInput {
  workType: WorkType;
  englishSlug?: string;
  requirementText: string;
}

export interface DefaultIssueTemplateInput {
  summary: string;
  requirementText: string;
  sourceText: string;
  repoPath?: string;
  branchName: string;
}

export interface IssueLogEntryInput {
  date: string;
  issueTitle: string;
  issueIid: number;
  issueProjectPath?: string;
  issueProjectId: number;
  issueWebUrl: string;
  mrIid?: number;
  mrUrl?: string;
  branchName: string;
  codeProjectPath?: string;
  codeProjectId: number;
  summary: string;
  status: string;
}

const FIX_KEYWORDS = [
  "bug",
  "fix",
  "error",
  "fault",
  "\u4fee\u590d",
  "\u9519\u8bef",
  "\u5f02\u5e38",
];
const CHORE_KEYWORDS = [
  "optimize",
  "optimization",
  "refactor",
  "performance",
  "\u4f18\u5316",
  "\u91cd\u6784",
];

const WORK_TYPE_PATTERN = /^[a-z][a-z0-9._-]*$/;

export function normalizeWorkType(value: string): WorkType {
  const normalized = value.trim().toLowerCase();
  if (!WORK_TYPE_PATTERN.test(normalized)) {
    throw new Error(
      "Invalid work type. Use a lowercase git/conventional prefix like feat, fix, docs, refactor, hotfix, feature.",
    );
  }
  return normalized;
}

export function isValidWorkType(value: string): boolean {
  return WORK_TYPE_PATTERN.test(value.trim().toLowerCase());
}

export function detectWorkType(requirementText: string): WorkType {
  const normalized = requirementText.toLowerCase();
  if (FIX_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return "fix";
  }
  if (CHORE_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return "chore";
  }
  return "feat";
}

function normalizeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, " ")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractAsciiSlug(requirementText: string): string {
  const words = requirementText.match(/[A-Za-z0-9]+/g);
  if (!words || words.length === 0) {
    return "";
  }
  return words.map((word) => word.toLowerCase()).join("-");
}

function fallbackSlug(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const s = String(now.getUTCSeconds()).padStart(2, "0");
  return `task-${y}${m}${d}-${h}${min}${s}`;
}

export function buildBranchName(input: BranchNameInput): string {
  const fromInput = input.englishSlug ? normalizeSlug(input.englishSlug) : "";
  const fromRequirement = normalizeSlug(extractAsciiSlug(input.requirementText));
  const slug = fromInput || fromRequirement || fallbackSlug();
  return `${normalizeWorkType(input.workType)}/${slug}`;
}

export function summarizeRequirement(requirementText: string, maxLength = 30): string {
  const compact = requirementText.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}...`;
}

export function buildIssueTitle(summary: string, label?: string): string {
  if (label?.trim()) {
    return `[${label.trim()}] ${summary}`;
  }
  return summary;
}

export function buildDefaultIssueDescription(input: DefaultIssueTemplateInput): string {
  const repoLine = input.repoPath ? input.repoPath : "N/A";
  const normalizedSource = input.sourceText.trim();
  const normalizedRequirement = input.requirementText.trim();
  const backgroundSection =
    normalizedSource && normalizedSource !== normalizedRequirement
      ? `\n### Background\n${normalizedSource}\n`
      : "";

  return `### Summary
${input.summary}

${backgroundSection}
### Expected Change
${normalizedRequirement}

### Scope
- Repository: ${repoLine}
- Suggested branch: \`${input.branchName}\``;
}

export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, rawKey: string) => {
    const key = String(rawKey);
    if (key in variables) {
      return variables[key];
    }
    return `{{${key}}}`;
  });
}

export function renderIssueLogEntry(input: IssueLogEntryInput): string {
  const issueProjectLine = input.issueProjectPath
    ? `${input.issueProjectPath} (project_id: ${input.issueProjectId})`
    : `project_id: ${input.issueProjectId}`;
  const codeProjectLine = input.codeProjectPath
    ? `${input.codeProjectPath} (project_id: ${input.codeProjectId})`
    : `project_id: ${input.codeProjectId}`;
  const mrRows =
    input.mrIid !== undefined || input.mrUrl?.trim()
      ? `| MR ID | ${input.mrIid !== undefined ? `\`${input.mrIid}\`` : "N/A"} |\n| MR URL | ${
          input.mrUrl?.trim() ? `\`${input.mrUrl.trim()}\`` : "N/A"
        } |\n`
      : "";

  return `## [${input.date}] ${input.issueTitle}

| Field | Value |
|------|-----|
| Issue ID (iid) | \`${input.issueIid}\` |
| Issue Project | ${issueProjectLine} |
| Issue URL | \`${input.issueWebUrl}\` |
${mrRows}| Code Branch | \`${input.branchName}\` |
| Code Project | ${codeProjectLine} |
| Status | ${input.status} |

**Summary**: ${input.summary}

**Lookup tips**:
- Query issue: \`gitlab_get_issue(project_id=${input.issueProjectId}, issue_iid=${input.issueIid})\`
- Query issue notes: \`gitlab_get_issue_notes(project_id=${input.issueProjectId}, issue_iid=${input.issueIid})\`

---
`;
}

export function renderIssueCompletionComment(input: {
  changedFiles: string[];
  branchName: string;
  codeProjectPath?: string;
  implementationSummary: string;
  acceptanceSteps: string;
}): string {
  const changedFileText =
    input.changedFiles.length > 0
      ? input.changedFiles.map((file) => `- ${file}`).join("\n")
      : "- No file list provided";
  const projectLine = input.codeProjectPath ?? "N/A";

  return `## Code changes completed

### Files changed
${changedFileText}

### Branch info
- Branch: \`${input.branchName}\`
- Project: ${projectLine}

### Implementation notes
${input.implementationSummary}

### Validation
${input.acceptanceSteps}`;
}

export function renderMergeRequestDescription(input: {
  issueProjectPath?: string;
  issueProjectId: number;
  issueIid: number;
  changeSummary: string;
  testPlan: string;
}): string {
  const issueRef = input.issueProjectPath
    ? `${input.issueProjectPath}#${input.issueIid}`
    : `project_id=${input.issueProjectId}, issue_iid=${input.issueIid}`;

  return `## Related issue
${issueRef}

## Change summary
${input.changeSummary}

## Test plan
${input.testPlan}`;
}
