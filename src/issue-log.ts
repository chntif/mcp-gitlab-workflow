import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export function resolveRepoScopedPath(repoPath: string, targetPath: string): string {
  return isAbsolute(targetPath) ? targetPath : resolve(repoPath, targetPath);
}

function toGitIgnoreEntry(repoPath: string, targetPath: string): string | undefined {
  const absoluteRepoPath = resolve(repoPath);
  const absoluteTargetPath = resolve(targetPath);
  const relativePath = relative(absoluteRepoPath, absoluteTargetPath);

  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }

  return relativePath.replace(/\\/g, "/");
}

async function ensureGitIgnoreEntry(repoPath: string, targetPath: string): Promise<void> {
  const ignoreEntry = toGitIgnoreEntry(repoPath, targetPath);
  if (!ignoreEntry) {
    return;
  }

  const gitIgnorePath = resolve(repoPath, ".gitignore");
  let currentContent = "";
  try {
    currentContent = await readFile(gitIgnorePath, "utf8");
  } catch {
    currentContent = "";
  }

  const existingEntries = new Set(
    currentContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  if (existingEntries.has(ignoreEntry)) {
    return;
  }

  const separator = currentContent.length === 0 || currentContent.endsWith("\n") ? "" : "\n";
  await writeFile(gitIgnorePath, `${currentContent}${separator}${ignoreEntry}\n`, "utf8");
}

export async function appendIssueLogMarkdown(
  repoPath: string,
  logPath: string,
  markdown: string,
): Promise<string> {
  const absolutePath = resolveRepoScopedPath(repoPath, logPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await ensureGitIgnoreEntry(repoPath, absolutePath);

  let content = "";
  try {
    content = await readFile(absolutePath, "utf8");
  } catch {
    content = "";
  }

  const spacer = content.endsWith("\n\n") || content.length === 0 ? "" : "\n";
  await writeFile(absolutePath, `${content}${spacer}${markdown}`, "utf8");
  return absolutePath;
}
