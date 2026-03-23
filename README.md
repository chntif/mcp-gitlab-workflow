# mcp-gitlab-workflow

`mcp-gitlab-workflow` 是一个面向 GitLab 的 MCP 服务，用来把需求、Issue、分支、提交、Merge Request、Issue 回填和本地仓库同步串成一套可调用的工作流。

它分成两类工具：

- `workflow_*`：偏业务流程编排，适合让 LLM 直接完成需求到交付的链路
- `gitlab_*`：偏 GitLab 原子能力，适合需要更细粒度控制的场景

## 功能概览

当前主要 workflow 工具：

- `workflow_requirement_to_issue`
- `workflow_prepare_delivery_workspace`
- `workflow_issue_to_delivery`
- `workflow_requirement_to_delivery`
- `workflow_sync_local_branch`
- `workflow_issue_log_append`
- `workflow_review_mr_post_comment`

当前主要 GitLab 原子工具：

- 用户与标签：`gitlab_get_current_user`、`gitlab_list_labels`、`gitlab_create_label`、`gitlab_update_label`、`gitlab_delete_label`
- Issue：`gitlab_create_issue`、`gitlab_get_issue`、`gitlab_get_issue_notes`、`gitlab_add_issue_comment`、`gitlab_get_issue_images`
- 仓库：`gitlab_create_branch`、`gitlab_get_file`、`gitlab_commit_files`、`gitlab_upload_project_file`
- MR：`gitlab_get_merge_request`、`gitlab_get_mr_notes`、`gitlab_create_merge_request`、`gitlab_create_mr_note`、`gitlab_get_mr_changes`、`gitlab_approve_mr`、`gitlab_unapprove_mr`

## 关键约束

### 1. delivery workflow 有硬前置步骤

`workflow_issue_to_delivery` 和 `workflow_requirement_to_delivery` 在执行之前，必须先调用：

- `workflow_prepare_delivery_workspace`

这个 prepare 工具会：

- 校验本地仓库是干净的
- 切到 `base_branch`
- 拉取最新代码
- 当 `delivery_method=local_git` 时，创建并切到本地工作分支
- 记录一份带时效的 `preparation_key`

随后 delivery workflow 会强校验：

- `preparation_key` 存在且未过期
- 若 `delivery_method=local_git`，当前仍停留在 prepare 创建的本地工作分支
- 若 `delivery_method=remote_api`，当前仍停留在 prepare 时的 `base_branch`
- 远程 `<remote>/<base_branch>` 没继续前进

如果校验失败，delivery 会拒绝执行，并要求重新 prepare。

### 2. `repo_path` 现在显式传入

本地 git 相关工具不再依赖 `process.cwd()` 猜项目目录，也不再使用 `WORKFLOW_LOCAL_REPO_PATH`。

需要本地仓库路径的工具现在都显式传 `repo_path`，例如：

- `workflow_prepare_delivery_workspace`
- `workflow_sync_local_branch`
- `workflow_issue_log_append`

### 3. 默认 delivery 模式现在是 `local_git`

新增环境变量：

- `WORKFLOW_DELIVERY_METHOD=local_git|remote_api`

默认值：

- `local_git`

两种模式的区别：

- `local_git`
  - prepare 阶段创建并切到本地工作分支
  - LLM 在这个本地分支上改代码
  - delivery 阶段负责 `git add/commit/push` 和创建 MR
  - 不要求 `commit_actions`
- `remote_api`
  - 保留原有 GitLab API 提交方式
  - delivery 阶段仍要求 `commit_actions`

### 4. issue log 路径按项目根目录解析

`WORKFLOW_ISSUE_LOG_PATH` 保留，但它只表示项目内的默认日志路径，例如：

- `issue-log.md`
- `docs/issue-log.md`

当它是相对路径时，会相对显式传入的 `repo_path` 或 prepare 记录里的 `repoPath` 解析。

因此当前默认落点是：

- `<workflow_prepare_delivery_workspace.repo_path>/issue-log.md`

### 5. `work_type` 不再写死为枚举

`work_type` 现在是受约束的普通字符串，而不是固定 `feat/fix/chore` 枚举。只要满足小写 git/conventional 前缀格式即可，例如：

- `feat`
- `fix`
- `docs`
- `refactor`
- `hotfix`
- `feature`

当前规则：

- 必须为小写
- 以字母开头
- 后续可包含 `a-z`、`0-9`、`.`、`_`、`-`

## 典型调用链路

### 需求只创建 Issue

1. 调 `workflow_requirement_to_issue`
2. 服务端解析需求、生成标题和分支名建议
3. 创建 GitLab Issue

### 现有 Issue 交付到 MR

默认 `local_git` 模式：

1. 调 `workflow_prepare_delivery_workspace`
2. prepare 已切到本地工作分支
3. 在该分支修改代码
4. 调 `workflow_issue_to_delivery`
5. 服务端执行本地 `commit/push`，然后创建 MR、Issue 评论，可选 issue log 更新

显式 `remote_api` 模式：

1. 调 `workflow_prepare_delivery_workspace`
2. 基于最新 `base_branch` 阅读代码并生成 `commit_actions`
3. 调 `workflow_issue_to_delivery`
4. 服务端通过 GitLab API 创建分支、提交、MR、Issue 评论，可选本地 checkout，可选 issue log 更新

### 从需求直接跑完整交付链

默认 `local_git` 模式：

1. 调 `workflow_prepare_delivery_workspace`
2. prepare 已切到本地工作分支
3. 在该分支修改代码
4. 调 `workflow_requirement_to_delivery`
5. 服务端先创建 Issue，再执行本地 `commit/push`、MR、Issue 评论和 issue log

显式 `remote_api` 模式：

1. 调 `workflow_prepare_delivery_workspace`
2. 基于最新 `base_branch` 阅读代码并生成 `commit_actions`
3. 调 `workflow_requirement_to_delivery`
4. 服务端先创建 Issue，再通过 GitLab API 完成分支、提交、MR、Issue 评论和 issue log

## 模板行为

### 默认 Issue 模板

默认 Issue 模板不再强制 `given / when / then`。当前默认 section 很轻：

- `Summary`
- `Background`，仅在 `source_text` 与 `requirement_text` 不同时渲染
- `Expected Change`
- `Scope`

如果传了 `issue_template`，服务端不再生成默认结构，只做 `{{key}}` 变量替换。

内置可用模板变量包括：

- `{{summary}}`
- `{{requirement_text}}`
- `{{source_text}}`
- `{{expected_change}}`
- `{{issue_project_id}}`
- `{{code_project_id}}`
- `{{issue_project_path}}`
- `{{code_project_path}}`
- `{{branch_name}}`
- `{{work_type}}`
- `{{label}}`

### 默认 MR 与评论模板

当前默认模板由服务端固定生成：

- MR 描述：`Related issue`、`Change summary`、`Test plan`
- Issue 完成评论：`Files changed`、`Branch info`、`Implementation notes`、`Validation`

delivery workflow 已移除自动 MR review comment。MR review 仍由独立工具 `workflow_review_mr_post_comment` 负责。

## 配置

### 必填环境变量

- `GITLAB_TOKEN`

### 常用环境变量

- `GITLAB_API_BASE_URL=https://gitlab.com/api/v4`
- `WORKFLOW_ISSUE_PROJECT_ID`
- `WORKFLOW_ISSUE_PROJECT_PATH`
- `WORKFLOW_CODE_PROJECT_ID`
- `WORKFLOW_CODE_PROJECT_PATH`
- `WORKFLOW_DELIVERY_METHOD=local_git`
- `WORKFLOW_BASE_BRANCH=develop`
- `WORKFLOW_TARGET_BRANCH=develop`
- `WORKFLOW_LABEL`
- `WORKFLOW_ASSIGNEE_USERNAME`
- `WORKFLOW_ISSUE_LOG_PATH=issue-log.md`
- `WORKFLOW_LOCAL_REMOTE_NAME=origin`
- `WORKFLOW_CHECKOUT_LOCAL_BRANCH=false`
- `WORKFLOW_UPDATE_ISSUE_LOG=true`

### 锁定环境变量

如果希望强制固定项目 ID，可使用：

- `WORKFLOW_LOCK_ISSUE_PROJECT_ID`
- `WORKFLOW_LOCK_CODE_PROJECT_ID`

## 安装与运行

### 方式一：本地构建后运行

```json
{
  "mcpServers": {
    "gitlab-workflow": {
      "command": "node",
      "args": ["/path/to/gitlab-workflow-server/dist/src/server.js"],
      "env": {
        "GITLAB_TOKEN": "YOUR_TOKEN",
        "GITLAB_API_BASE_URL": "https://gitlab.com/api/v4"
      }
    }
  }
}
```

### 方式二：通过 npx

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

## 运行时原则

- 工具参数优先于环境变量
- 环境变量优先于代码默认值
- 若仍缺失，返回明确错误，不让 LLM 猜 `project_id`、仓库路径等强环境参数
- Issue 类原子工具默认回落到 `WORKFLOW_ISSUE_PROJECT_ID`
- 代码 / MR 类原子工具默认回落到 `WORKFLOW_CODE_PROJECT_ID`
- 通用原子工具只在 issue/code 项目默认值不冲突时才会自动回落
- delivery workflow 默认回落到 `WORKFLOW_DELIVERY_METHOD=local_git`

## 内部状态文件

`workflow_prepare_delivery_workspace` 会在服务端自身目录下维护临时状态文件：

- `.mcp-state/delivery-preparations.json`

这个文件保存尚未消费的 `preparation_key`，用于后续 delivery 校验。它是临时状态缓存，不是历史日志。

## License

MIT
