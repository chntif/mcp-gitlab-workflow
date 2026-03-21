# mcp-gitlab-workflow

`mcp-gitlab-workflow` 是一个面向 GitLab 的 MCP 服务，目标是让 AI Agent 通过工具调用完成完整研发流程：需求解析、Issue、分支、提交、MR、审查评论、Issue 回填。基于你的一个需求或现有Issue自动完成规范化的功能开发，实现面向Issue开发。

## 1. 核心能力

- `workflow_*`：工作流编排工具，适合“直接完成任务链路”
- `gitlab_*`：原子 API 工具，适合“自定义编排与精细控制”

## 2. Workflow 工具

- `workflow_requirement_to_issue`：分析需求并创建 Issue（支持标签自动建议/自动创建、默认指派给当前用户）
- `workflow_review_mr_post_comment`：读取 MR 变更并发布审查评论，可选自动审批
- `workflow_issue_to_delivery`：基于已有 Issue 完成“建分支→提交→MR→审查评论→Issue 评论→Issue Log”
- `workflow_requirement_to_delivery`：从需求开始的一体化全链路（先建 Issue，再走 `workflow_issue_to_delivery`）

## 3. GitLab 原子工具

- 用户与标签：`gitlab_get_current_user`、`gitlab_list_labels`、`gitlab_create_label`、`gitlab_update_label`、`gitlab_delete_label`
- Issue：`gitlab_create_issue`、`gitlab_get_issue`、`gitlab_get_issue_notes`、`gitlab_add_issue_comment`（支持基于 MR 变更自动生成评论）、`gitlab_get_issue_images`
- 仓库：`gitlab_create_branch`、`gitlab_get_file`、`gitlab_commit_files`、`gitlab_upload_project_file`
- MR：`gitlab_get_merge_request`、`gitlab_get_mr_notes`、`gitlab_create_merge_request`、`gitlab_create_mr_note`、`gitlab_get_mr_changes`、`gitlab_approve_mr`、`gitlab_unapprove_mr`

## 4. 使用方式

### 4.1 本地启动

```json
{
  "mcpServers": {
    "gitlab-workflow": {
      "command": "node",
      "args": ["/gitlab-workflow-server/dist/src/server.js"],
      "env": {
        "GITLAB_TOKEN": "YOUR_TOKEN",
        "GITLAB_API_BASE_URL": "https://gitlab.com/api/v4"
      }
    }
  }
}
```

### 4.2 使用NPX

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

本项目是 Node.js 包，推荐 `npx` 方式运行。`uv/uvx` 会在后续上传。

## 5. 环境变量

说明：

- 环境变量统一走“工具参数 -> 用户 env -> 代码内默认值”的优先级
- 只有通用且安全的配置项才提供内置默认值；项目 ID、本地仓库路径这类与具体环境强相关的字段默认仍然是未配置状态
- 对工具中带 env fallback 的字段，建议“未明确指定就省略”，让服务回落到当前配置值；如果当前配置仍未设置，服务会返回缺参错误，不应让模型自行猜测

启动必需有效值：

- `GITLAB_TOKEN`
- `GITLAB_API_BASE_URL`

已提供的内置默认值：

- `GITLAB_API_BASE_URL=https://gitlab.com/api/v4`
- `WORKFLOW_BASE_BRANCH=develop`
- `WORKFLOW_TARGET_BRANCH=develop`
- `WORKFLOW_ISSUE_LOG_PATH=issue-log.md`
- `WORKFLOW_LOCAL_REMOTE_NAME=origin`

默认未配置、需要用户显式传参或设置 env 的配置项：

- `WORKFLOW_ISSUE_PROJECT_ID`
- `WORKFLOW_ISSUE_PROJECT_PATH`
- `WORKFLOW_CODE_PROJECT_ID`
- `WORKFLOW_CODE_PROJECT_PATH`
- `WORKFLOW_LOCAL_REPO_PATH`

其余配置项可以通过 env 覆盖内置默认值：

- `WORKFLOW_BASE_BRANCH`
- `WORKFLOW_TARGET_BRANCH`
- `WORKFLOW_LABEL`
- `WORKFLOW_ASSIGNEE_USERNAME`
- `WORKFLOW_ISSUE_LOG_PATH`
- `WORKFLOW_LOCAL_REMOTE_NAME`

可选强约束（锁项目）：

- `WORKFLOW_LOCK_ISSUE_PROJECT_ID`
- `WORKFLOW_LOCK_CODE_PROJECT_ID`

## 6. License

MIT
