# GitLab Workflow MCP Server

这个服务是一个基于 MCP 的 GitLab 自动化服务，目标是让智能体可以通过 tool 调用，完成你定义的开发流程。

核心思想：

- 能用 GitLab API 做的动作，全部做成 MCP tool。
- 固定流程参数内置默认值，避免手工调用时填错项目或分支。
- 保留通用 API tool，方便后续扩展其它流程。

## 1. 目录结构

```text
mcp/gitlab-workflow-server
├── src
│   ├── config.ts      # 固定配置 + 环境变量读取
│   ├── gitlab.ts      # GitLab REST API 封装
│   ├── server.ts      # MCP tools 注册和编排
│   └── workflow.ts    # 需求解析、模板拼装、log 文本生成
├── tests
│   └── workflow.test.ts
├── package.json
└── tsconfig.json
```

## License

MIT

## 2. 固定默认配置（可通过环境变量覆盖）

- Issue 项目 ID: `893`
- 代码项目 ID: `2160`
- 基础分支: `develop`
- 目标分支: `develop`
- Label: `前端`
- 指派用户名: `chenba`
- issue log 路径: `issue/log.md`

对应环境变量：

- `WORKFLOW_ISSUE_PROJECT_ID`
- `WORKFLOW_ISSUE_PROJECT_PATH`
- `WORKFLOW_CODE_PROJECT_ID`
- `WORKFLOW_CODE_PROJECT_PATH`
- `WORKFLOW_BASE_BRANCH`
- `WORKFLOW_TARGET_BRANCH`
- `WORKFLOW_LABEL`
- `WORKFLOW_ASSIGNEE_USERNAME`
- `WORKFLOW_ISSUE_LOG_PATH`

## 3. 启动前准备

必须设置：

- `GITLAB_TOKEN`：你的 GitLab Personal Access Token
- `GITLAB_API_BASE_URL`：默认是 `https://git.gobies.org/api/v4`

PowerShell 示例：

```powershell
$env:GITLAB_TOKEN="YOUR_TOKEN"
$env:GITLAB_API_BASE_URL="https://git.gobies.org/api/v4"
```

安装和构建：

```powershell
cd mcp/gitlab-workflow-server
npm install
npm test
npm run build
```

本地启动（stdio）：

```powershell
npm run start
```

## 4. 通用 GitLab Tool（可单独调用）

- `gitlab_get_issue`
- `gitlab_create_issue`
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

## 5. MCP 客户端配置示例

```json
{
  "mcpServers": {
    "gitlab-workflow": {
      "command": "node",
      "args": ["/gitlab-workflow-server/dist/src/server.js"],
      "env": {
        "GITLAB_TOKEN": "YOUR_TOKEN",
        "GITLAB_API_BASE_URL": "https://git.gobies.org/api/v4"
      }
    }
  }
}
```
