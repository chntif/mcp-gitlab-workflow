# mcp-gitlab-workflow

一个面向 GitLab 开发流程的 MCP Server，支持：
- 自动化流程工具（创建 issue、建分支、加评论、创建 MR、更新本地 issue 日志）
- 通用 GitLab API 工具（issue / branch / file / commit / MR / approve）

## 设计原则

1. 不写死业务项目参数  
项目 ID、分支、路径等都来自：
- tool 调用参数（优先）
- 环境变量（可选兜底）

2. 不内置固定项目默认值  
仓库里没有写死 `893/2160/develop` 这类值；这些都需要你传入或在环境变量中显式配置。

3. 缺参可读报错  
如果缺少必要参数，工具会返回：
- 缺哪个字段
- 从哪里补（tool args 或指定 env）

4. 可选项目锁  
你可以只锁 issue 项目，或只锁 code 项目，防止误操作到其他项目。

## 为什么 TypeScript import 要写 `.js`

本项目使用 Node ESM + `moduleResolution: NodeNext`。  
在这种模式下，TypeScript 源码中的相对导入必须写成运行时真实扩展名（`.js`），例如：

```ts
import { getRuntimeConfig } from "./config.js";
```

这是 Node ESM 解析规则，不是 MCP 特有规则。

## Issue 模板策略

`workflow_start` 支持两种模式：

1. 你传了 `issue_template`  
优先使用你的模板，支持 `{{variable}}` 渲染。  
可通过 `template_variables` 额外传参。

2. 你没传 `issue_template`  
回退到内置模板，此时会要求你提供：
- `expected_behavior`
- `given`
- `when`
- `then`

## 环境变量

必填：
- `GITLAB_TOKEN`
- `GITLAB_API_BASE_URL`

可选默认值（不给就必须在 tool 参数里传）：
- `WORKFLOW_ISSUE_PROJECT_ID`
- `WORKFLOW_ISSUE_PROJECT_PATH`
- `WORKFLOW_CODE_PROJECT_ID`
- `WORKFLOW_CODE_PROJECT_PATH`
- `WORKFLOW_BASE_BRANCH`
- `WORKFLOW_TARGET_BRANCH`
- `WORKFLOW_LABEL`
- `WORKFLOW_ASSIGNEE_USERNAME`
- `WORKFLOW_ISSUE_LOG_PATH`

可选项目锁：
- `WORKFLOW_LOCK_ISSUE_PROJECT_ID`
- `WORKFLOW_LOCK_CODE_PROJECT_ID`

说明：
- 只设置 `WORKFLOW_LOCK_ISSUE_PROJECT_ID`：只锁 issue 相关工具。
- 只设置 `WORKFLOW_LOCK_CODE_PROJECT_ID`：只锁代码/MR 相关工具。
- 两个都设：两个方向都锁。

## 工具列表

## Workflow Tools

- `workflow_parse_requirement`
  - 作用：从需求文本解析 `work_type`、`issue_title`、`branch_name`
- `workflow_start`
  - 作用：创建 issue + 创建分支 + 可选追加本地 issue log
- `workflow_append_issue_log`
  - 作用：单独追加本地 issue log
- `workflow_add_issue_comment`
  - 作用：给 issue 加评论（直接 body 或模板生成）
- `workflow_create_merge_request`
  - 作用：创建 MR + 可选更新本地 issue log 状态
- `workflow_complete`
  - 作用：一步完成 issue 评论 + 创建 MR + 可选更新日志

## GitLab API Tools

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

这些工具的参数设计参考 GitLab 官方 REST API 字段语义，例如：
- `assignee_ids`
- `reviewer_ids`
- `milestone_id`
- `due_date`
- `remove_source_branch`
- `squash`

每个参数在 `server.ts` 的 `inputSchema` 里都有 `describe(...)` 说明，方便 AI 调用时理解参数用途。

工具返回已升级为 `outputSchema + structuredContent`，调用方可稳定解析结构化字段。

## 本地开发

```bash
npm install
npm run build
npm run start
```

## 关于 tests 目录

当前仓库不再包含 `tests/` 测试代码。  
`npm test` 仅输出提示，不会调用 GitLab API，也不会创建 issue。

## License

MIT
