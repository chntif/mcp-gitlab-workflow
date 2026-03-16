# mcp-gitlab-workflow

## 1. 项目介绍

`mcp-gitlab-workflow` 是一个基于 MCP 的 GitLab 工作流服务，目标是让 LLM 可以通过工具调用完成常见研发动作：

- 创建和查询 Issue
- 创建分支、读取文件、提交代码
- 创建 Merge Request、评论、审批/取消审批
- 执行一体化工作流（从需求解析到 issue/MR 产出）

服务同时提供：

- `workflow_*`：偏业务流程编排工具
- `gitlab_*`：偏原子 API 能力工具

## 2. Tools 列表与功能

### Workflow 工具

- `workflow_parse_requirement`：解析需求文本，生成 `work_type`、`issue_title`、`branch_name`
- `workflow_start`：创建 issue + 创建分支 + 可选更新本地 issue log
- `workflow_append_issue_log`：仅追加 issue log
- `workflow_add_issue_comment`：给 issue 添加评论（直传或模板生成）
- `workflow_create_merge_request`：创建 MR + 可选更新 issue log
- `workflow_complete`：一键完成“issue 评论 + 创建 MR + 可选更新日志”

### GitLab 原子工具

- `gitlab_create_issue`
- `gitlab_get_issue`
- `gitlab_get_issue_notes`
- `gitlab_add_issue_comment`
- `gitlab_create_branch`
- `gitlab_get_file`
- `gitlab_commit_files`
- `gitlab_create_merge_request`
- `gitlab_create_mr_note`
- `gitlab_get_mr_changes`
- `gitlab_approve_mr`
- `gitlab_unapprove_mr`

## 3. 使用方法

### 3.1 本地开发

```bash
npm install
npm run build
npm run start
```

### 3.2 MCP 客户端接入（Node 包发布后）

推荐（Node 环境）：

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

### 3.3 环境变量

必填：

- `GITLAB_TOKEN`
- `GITLAB_API_BASE_URL`

可选（流程默认值/锁）：

- `WORKFLOW_ISSUE_PROJECT_ID`
- `WORKFLOW_ISSUE_PROJECT_PATH`
- `WORKFLOW_CODE_PROJECT_ID`
- `WORKFLOW_CODE_PROJECT_PATH`
- `WORKFLOW_BASE_BRANCH`
- `WORKFLOW_TARGET_BRANCH`
- `WORKFLOW_LABEL`
- `WORKFLOW_ASSIGNEE_USERNAME`
- `WORKFLOW_ISSUE_LOG_PATH`
- `WORKFLOW_LOCK_ISSUE_PROJECT_ID`
- `WORKFLOW_LOCK_CODE_PROJECT_ID`


## 4. License

MIT
