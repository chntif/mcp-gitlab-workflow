import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBranchName,
  buildIssueDescription,
  buildIssueTitle,
  detectWorkType,
  renderIssueLogEntry,
} from "../src/workflow.js";

test("detectWorkType returns fix when requirement looks like bugfix", () => {
  const workType = detectWorkType("修复登录页空白屏 bug");
  assert.equal(workType, "fix");
});

test("detectWorkType returns chore when requirement looks like optimization", () => {
  const workType = detectWorkType("优化筛选性能，减少重复请求");
  assert.equal(workType, "chore");
});

test("detectWorkType defaults to feat for normal feature text", () => {
  const workType = detectWorkType("新增资产列表导出按钮");
  assert.equal(workType, "feat");
});

test("buildBranchName prefers provided english slug", () => {
  const branch = buildBranchName({
    workType: "feat",
    englishSlug: "asset-export-button",
    requirementText: "新增资产列表导出按钮",
  });

  assert.equal(branch, "feat/asset-export-button");
});

test("buildBranchName extracts ascii words when no slug provided", () => {
  const branch = buildBranchName({
    workType: "fix",
    requirementText: "Fix Export Button not clickable",
  });

  assert.equal(branch, "fix/fix-export-button-not-clickable");
});

test("buildIssueTitle adds fixed label prefix", () => {
  const title = buildIssueTitle("新增资产列表导出按钮");
  assert.equal(title, "[前端] 新增资产列表导出按钮");
});

test("buildIssueDescription renders required sections", () => {
  const description = buildIssueDescription({
    sourceText: "产品提出资产导出需求",
    expectedBehavior: "用户可以一键导出当前筛选结果",
    currentBehavior: "当前没有导出按钮",
    given: "用户已登录并进入资产列表",
    when: "点击导出按钮",
    then: "浏览器下载导出文件",
    repoPath: "fofa-frontend/fofa-frontend-v5",
  });

  assert.match(description, /### 1\. 背景与业务目标/);
  assert.match(description, /\* \*\*问题\/需求来源\*\*: 产品提出资产导出需求/);
  assert.match(description, /### 2\. 功能\/修复描述/);
  assert.match(description, /\* \*\*当前行为\*\* \(对于 Bug 或优化\): 当前没有导出按钮/);
  assert.match(description, /\* \*\*期望行为\*\*: 用户可以一键导出当前筛选结果/);
  assert.match(description, /### 3\. 验收标准/);
  assert.match(description, /- GIVEN 用户已登录并进入资产列表/);
  assert.match(description, /- WHEN 点击导出按钮/);
  assert.match(description, /- THEN 浏览器下载导出文件/);
  assert.match(description, /\* \*\*涉及代码库\*\*: fofa-frontend\/fofa-frontend-v5/);
});

test("renderIssueLogEntry writes expected markdown block", () => {
  const issueProjectId = 2323;
  const markdown = renderIssueLogEntry({
    date: "2026-03-16",
    issueTitle: "[前端] 新增资产列表导出按钮",
    issueIid: 123,
    issueProjectPath: "Projects_MGMT/featuredesign",
    issueProjectId,
    issueWebUrl: "https://git.gobies.org/Projects_MGMT/featuredesign/-/issues/123",
    branchName: "feat/asset-export-button",
    codeProjectPath: "fofa-frontend/fofa-frontend-v5",
    codeProjectId: 2160,
    summary: "新增资产列表导出按钮",
    status: "进行中",
  });

  assert.match(markdown, /## \[2026-03-16\] \[前端\] 新增资产列表导出按钮/);
  assert.match(markdown, /\| Issue ID \(iid\) \| `123` \|/);
  assert.match(markdown, /\| 代码分支 \| `feat\/asset-export-button` \|/);
  assert.match(markdown, /\| 状态 \| 进行中 \|/);
  assert.match(markdown, new RegExp(`gitlab\\.get_issue\\(project_id=${issueProjectId}, issue_iid=123\\)`));
});
