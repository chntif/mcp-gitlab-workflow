import { spawn } from "node:child_process";

export class LocalGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalGitError";
  }
}

export async function runGitInRepo(
  toolName: string,
  repoPath: string,
  gitArgs: string[],
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["-C", repoPath, ...gitArgs], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      rejectPromise(
        new LocalGitError(
          `[${toolName}] Failed to execute git command: git -C ${repoPath} ${gitArgs.join(" ")} (${error.message})`,
        ),
      );
    });

    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(
          new LocalGitError(
            `[${toolName}] Git command failed (exit=${code}): git -C ${repoPath} ${gitArgs.join(
              " ",
            )}\n${stderr || stdout}`,
          ),
        );
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

export async function ensureCleanWorktree(toolName: string, repoPath: string): Promise<void> {
  const status = await runGitInRepo(toolName, repoPath, ["status", "--porcelain"]);
  if (status.trim()) {
    throw new LocalGitError(
      `[${toolName}] Local repository '${repoPath}' has uncommitted changes. Clean the worktree before running this workflow.`,
    );
  }
}

export async function getCurrentBranchName(toolName: string, repoPath: string): Promise<string> {
  return runGitInRepo(toolName, repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function getHeadSha(toolName: string, repoPath: string, rev = "HEAD"): Promise<string> {
  return runGitInRepo(toolName, repoPath, ["rev-parse", rev]);
}

async function ensureBranchDoesNotExist(
  toolName: string,
  repoPath: string,
  remoteName: string,
  workingBranch: string,
): Promise<void> {
  const localBranch = await runGitInRepo(toolName, repoPath, ["branch", "--list", workingBranch]);
  if (localBranch.trim()) {
    throw new LocalGitError(
      `[${toolName}] Local branch '${workingBranch}' already exists. Use a different branch name or clean up the existing branch first.`,
    );
  }

  const remoteBranch = await runGitInRepo(toolName, repoPath, [
    "branch",
    "-r",
    "--list",
    `${remoteName}/${workingBranch}`,
  ]);
  if (remoteBranch.trim()) {
    throw new LocalGitError(
      `[${toolName}] Remote branch '${remoteName}/${workingBranch}' already exists. Use a different branch name or inspect the existing delivery first.`,
    );
  }
}

export async function prepareLocalWorkingBranch(params: {
  toolName: string;
  repoPath: string;
  remoteName: string;
  baseBranch: string;
  workingBranch: string;
}): Promise<{
  repo_path: string;
  remote_name: string;
  base_branch: string;
  working_branch: string;
  current_branch: string;
  base_head_sha: string;
  commands: string[];
}> {
  await ensureCleanWorktree(params.toolName, params.repoPath);

  const commands: string[] = [];
  const pushCommand = (args: string[]) => {
    commands.push(`git -C ${params.repoPath} ${args.join(" ")}`);
  };

  const fetchArgs = ["fetch", params.remoteName, params.baseBranch];
  pushCommand(fetchArgs);
  await runGitInRepo(params.toolName, params.repoPath, fetchArgs);

  const checkoutBaseArgs = ["checkout", params.baseBranch];
  pushCommand(checkoutBaseArgs);
  await runGitInRepo(params.toolName, params.repoPath, checkoutBaseArgs);

  const pullArgs = ["pull", params.remoteName, params.baseBranch];
  pushCommand(pullArgs);
  await runGitInRepo(params.toolName, params.repoPath, pullArgs);

  await ensureBranchDoesNotExist(
    params.toolName,
    params.repoPath,
    params.remoteName,
    params.workingBranch,
  );

  const checkoutWorkingArgs = ["checkout", "-b", params.workingBranch];
  pushCommand(checkoutWorkingArgs);
  await runGitInRepo(params.toolName, params.repoPath, checkoutWorkingArgs);

  const currentBranch = await getCurrentBranchName(params.toolName, params.repoPath);
  const baseHeadSha = await getHeadSha(
    params.toolName,
    params.repoPath,
    `${params.remoteName}/${params.baseBranch}`,
  );

  return {
    repo_path: params.repoPath,
    remote_name: params.remoteName,
    base_branch: params.baseBranch,
    working_branch: params.workingBranch,
    current_branch: currentBranch,
    base_head_sha: baseHeadSha,
    commands,
  };
}

export async function commitAndPushLocalBranch(params: {
  toolName: string;
  repoPath: string;
  remoteName: string;
  workingBranch: string;
  commitMessage: string;
}): Promise<{
  repo_path: string;
  remote_name: string;
  branch_name: string;
  current_branch: string;
  commit_sha: string;
  short_sha: string;
  title: string;
  changed_files: string[];
  commands: string[];
}> {
  const commands: string[] = [];
  const pushCommand = (args: string[]) => {
    commands.push(`git -C ${params.repoPath} ${args.join(" ")}`);
  };

  const currentBranch = await getCurrentBranchName(params.toolName, params.repoPath);
  if (currentBranch.trim() !== params.workingBranch) {
    throw new LocalGitError(
      `[${params.toolName}] Expected current branch '${params.workingBranch}', got '${currentBranch.trim()}'.`,
    );
  }

  const addArgs = ["add", "-A"];
  pushCommand(addArgs);
  await runGitInRepo(params.toolName, params.repoPath, addArgs);

  const changedFilesOutput = await runGitInRepo(params.toolName, params.repoPath, [
    "diff",
    "--cached",
    "--name-only",
  ]);
  const changedFiles = changedFilesOutput
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (changedFiles.length === 0) {
    throw new LocalGitError(
      `[${params.toolName}] No local changes were detected on branch '${params.workingBranch}'. Modify files before running delivery.`,
    );
  }

  const commitArgs = ["commit", "-m", params.commitMessage];
  pushCommand(commitArgs);
  await runGitInRepo(params.toolName, params.repoPath, commitArgs);

  const pushArgs = ["push", "-u", params.remoteName, params.workingBranch];
  pushCommand(pushArgs);
  await runGitInRepo(params.toolName, params.repoPath, pushArgs);

  const commitSha = await getHeadSha(params.toolName, params.repoPath);
  const shortSha = await runGitInRepo(params.toolName, params.repoPath, ["rev-parse", "--short", "HEAD"]);
  const title = await runGitInRepo(params.toolName, params.repoPath, ["log", "-1", "--pretty=%s"]);

  return {
    repo_path: params.repoPath,
    remote_name: params.remoteName,
    branch_name: params.workingBranch,
    current_branch: currentBranch.trim(),
    commit_sha: commitSha.trim(),
    short_sha: shortSha.trim(),
    title: title.trim(),
    changed_files: changedFiles,
    commands,
  };
}
