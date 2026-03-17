# mcp-gitlab-workflow

`mcp-gitlab-workflow` 是一个面向 GitLab 的 MCP 服务，目标是让 AI Agent 通过工具调用完成完整研发流程：需求解析、Issue、分支、提交、MR、审查评论、Issue 回填、以及本地仓库分支同步。

## 1. 核心能力

- `workflow_*`：工作流编排工具，适合“直接完成任务链路”
- `gitlab_*`：原子 API 工具，适合“自定义编排与精细控制”

> 说明：`workflow_start` 与 `workflow_complete` 已在当前版本彻底移除，统一使用新工作流工具。

## 2. Workflow 工具

- `workflow_analyze_and_create_issue`：分析需求并创建 Issue（支持标签自动建议/自动创建、默认指派给当前用户）
- `workflow_review_mr_and_comment`：读取 MR 变更并发布审查评论，可选自动审批
- `workflow_local_sync_checkout_branch`：本地仓库 `fetch/pull/checkout` 切换到目标分支
- `workflow_issue_to_mr_full`：基于已有 Issue 完成“建分支→提交→MR→审查评论→本地切分支→Issue 评论→Issue Log”
- `workflow_requirement_to_delivery_full`：从需求开始的一体化全链路（先建 Issue，再走 `issue_to_mr_full`）
- `workflow_append_issue_log`：向本地 issue log 追加记录
- `workflow_add_issue_comment`：给 issue 添加评论（支持模板）
- `workflow_create_merge_request`：创建 MR 并可选更新 issue log

## 3. GitLab 原子工具

- 用户与标签：`gitlab_get_current_user`、`gitlab_list_labels`、`gitlab_create_label`、`gitlab_update_label`、`gitlab_delete_label`
- Issue：`gitlab_create_issue`、`gitlab_get_issue`、`gitlab_get_issue_notes`、`gitlab_add_issue_comment`、`gitlab_get_issue_images`
- 仓库：`gitlab_create_branch`、`gitlab_get_file`、`gitlab_commit_files`、`gitlab_upload_project_file`
- MR：`gitlab_get_merge_request`、`gitlab_get_mr_notes`、`gitlab_create_merge_request`、`gitlab_create_mr_note`、`gitlab_get_mr_changes`、`gitlab_approve_mr`、`gitlab_unapprove_mr`

## 4. 使用方式

### 4.1 本地开发运行

```bash
npm install
npm run build
npm run start
```

### 4.2 MCP 客户端配置（npx）

```json
{
  "mcpServers": {
    "gitlab-workflow": {
      "command": "npx",
      "args": ["-y", "mcp-gitlab-workflow"],
      "env": {
        "GITLAB_TOKEN": "YOUR_TOKEN",
        "GITLAB_API_BASE_URL": "https://gitlab.com/api/v4"
      }
    }
  }
}
```

### 4.3 关于 `uv/uvx`

本项目是 Node.js 包，推荐 `npx` 方式运行。`uv/uvx` 主要用于 Python 生态，不是本包的首选启动方式。

## 5. 环境变量

必填：

- `GITLAB_TOKEN`
- `GITLAB_API_BASE_URL`

可选默认值：

- `WORKFLOW_ISSUE_PROJECT_ID`
- `WORKFLOW_ISSUE_PROJECT_PATH`
- `WORKFLOW_CODE_PROJECT_ID`
- `WORKFLOW_CODE_PROJECT_PATH`
- `WORKFLOW_BASE_BRANCH`
- `WORKFLOW_TARGET_BRANCH`
- `WORKFLOW_LABEL`
- `WORKFLOW_ASSIGNEE_USERNAME`
- `WORKFLOW_ISSUE_LOG_PATH`
- `WORKFLOW_LOCAL_REPO_PATH`
- `WORKFLOW_LOCAL_REMOTE_NAME`

可选强约束（锁项目）：

- `WORKFLOW_LOCK_ISSUE_PROJECT_ID`
- `WORKFLOW_LOCK_CODE_PROJECT_ID`

## 6. License

MIT
