export type WorkType = "feat" | "fix" | "chore";

export interface BranchNameInput {
  workType: WorkType;
  englishSlug?: string;
  requirementText: string;
}

export interface IssueDescriptionInput {
  sourceText: string;
  expectedBehavior: string;
  currentBehavior?: string;
  given: string;
  when: string;
  then: string;
  repoPath: string;
}

export interface IssueLogEntryInput {
  date: string;
  issueTitle: string;
  issueIid: number;
  issueProjectPath: string;
  issueProjectId: number;
  issueWebUrl: string;
  branchName: string;
  codeProjectPath: string;
  codeProjectId: number;
  summary: string;
  status: string;
}

const FIX_KEYWORDS = ["bug", "fix", "错误", "修复", "异常", "故障", "崩溃"];
const CHORE_KEYWORDS = ["优化", "optimize", "优化", "重构", "refactor", "性能"];

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
  return `${input.workType}/${slug}`;
}

export function summarizeRequirement(requirementText: string, maxLength = 30): string {
  const compact = requirementText.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}…`;
}

export function buildIssueTitle(featureSummary: string): string {
  return `[前端] ${featureSummary}`;
}

export function buildIssueDescription(input: IssueDescriptionInput): string {
  const currentBehaviorLine = input.currentBehavior
    ? `* **当前行为** (对于 Bug 或优化): ${input.currentBehavior}\n`
    : "";

  return `### 1. 背景与业务目标 (Why?)
* **问题/需求来源**: ${input.sourceText}

### 2. 功能/修复描述 (What?)
${currentBehaviorLine}* **期望行为**: ${input.expectedBehavior}

### 3. 验收标准 (Acceptance Criteria - AC)
*使用 GIVEN-WHEN-THEN 格式*
- GIVEN ${input.given}
- WHEN ${input.when}
- THEN ${input.then}

### 4. 涉及范围与关联项
* **涉及代码库**: ${input.repoPath}
* **设计稿/原型链接**: 暂无
* **API 文档链接**: 暂无
* **其他相关文档**: 暂无`;
}

export function renderIssueLogEntry(input: IssueLogEntryInput): string {
  return `## [${input.date}] ${input.issueTitle}

| 字段 | 值 |
|------|-----|
| Issue ID (iid) | \`${input.issueIid}\` |
| Issue 项目 | ${input.issueProjectPath} (project_id: ${input.issueProjectId}) |
| Issue URL | \`${input.issueWebUrl}\` |
| 代码分支 | \`${input.branchName}\` |
| 代码项目 | ${input.codeProjectPath} (project_id: ${input.codeProjectId}) |
| 状态 | ${input.status} |

**问题描述**：${input.summary}

**AI 定位参数**：
- 查询 Issue：\`gitlab.get_issue(project_id=${input.issueProjectId}, issue_iid=${input.issueIid})\`
- 查询评论：\`gitlab.get_workitem_notes(project_id=${input.issueProjectId}, workitem_id=${input.issueIid})\`

---
`;
}

export function renderIssueCompletionComment(input: {
  changedFiles: string[];
  branchName: string;
  codeProjectPath: string;
  implementationSummary: string;
  acceptanceSteps: string;
}): string {
  const changedFileText =
    input.changedFiles.length > 0
      ? input.changedFiles.map((file) => `- ${file}`).join("\n")
      : "- 无文件变更信息";

  return `## ✅ 代码修改完成

### 修改内容
${changedFileText}

### 分支信息
- **代码分支**：\`${input.branchName}\`
- **代码项目**：${input.codeProjectPath}

### 改动说明
${input.implementationSummary}

### 验收方式
${input.acceptanceSteps}`;
}

export function renderMergeRequestDescription(input: {
  issueProjectPath: string;
  issueIid: number;
  changeSummary: string;
  testPlan: string;
}): string {
  return `## 关联 Issue
${input.issueProjectPath}#${input.issueIid}

## 改动说明
${input.changeSummary}

## 测试说明
${input.testPlan}`;
}
