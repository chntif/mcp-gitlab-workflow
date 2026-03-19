export interface PreparedMrReviewDiff {
  old_path?: string;
  new_path?: string;
  diff: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  diff_truncated?: boolean;
}

export interface PreparedMrReviewContext {
  review_prompt: string;
  changed_files: string[];
  diffs: PreparedMrReviewDiff[];
  existing_notes_count?: number;
}

export function buildPreparedMrReviewContext(params: {
  reviewSummary?: string;
  existingNotesCount?: number;
  changesPayload: any;
  maxFiles?: number;
  maxDiffCharsPerFile?: number;
}): PreparedMrReviewContext {
  const maxFiles = params.maxFiles ?? 20;
  const maxDiffCharsPerFile = params.maxDiffCharsPerFile ?? 12000;
  const rawChanges = Array.isArray(params.changesPayload?.changes) ? params.changesPayload.changes : [];
  const selectedChanges = rawChanges.slice(0, maxFiles);

  const diffs: PreparedMrReviewDiff[] = selectedChanges.map((item: any) => {
    const rawDiff = typeof item?.diff === "string" ? item.diff : "";
    const diff = rawDiff.slice(0, maxDiffCharsPerFile);

    return {
      old_path: typeof item?.old_path === "string" ? item.old_path : undefined,
      new_path: typeof item?.new_path === "string" ? item.new_path : undefined,
      diff,
      new_file: typeof item?.new_file === "boolean" ? item.new_file : undefined,
      renamed_file: typeof item?.renamed_file === "boolean" ? item.renamed_file : undefined,
      deleted_file: typeof item?.deleted_file === "boolean" ? item.deleted_file : undefined,
      diff_truncated: rawDiff.length > diff.length ? true : undefined,
    };
  });

  const changed_files = diffs
    .map((item) => item.new_path?.trim() || item.old_path?.trim())
    .filter((path): path is string => Boolean(path));

  return {
    review_prompt: buildMrReviewPrompt(params.reviewSummary),
    changed_files,
    diffs,
    existing_notes_count: params.existingNotesCount,
  };
}

function buildMrReviewPrompt(reviewSummary?: string): string {
  const summaryLine = reviewSummary?.trim() ? `补充要求：${reviewSummary.trim()}\n` : "";

  return [
    "你是严格的 MR reviewer。",
    "只关注 bug、回归、风险、缺失测试。",
    "不要表扬、不要复述代码、不要给样式建议。",
    summaryLine.trimEnd(),
    "若无阻塞问题，直接输出：No blocking issues found.",
    "若有问题，按严重度列点：`- [high|medium|low] 文件路径：问题`，并给一句原因/建议。",
    "只基于提供的 diff 和上下文判断，不猜测未展示的实现。",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}
