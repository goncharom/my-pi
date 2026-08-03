import type { StoredCodeComment, StoredPlanComment } from "./comment-store";

export function compilePlanReview(comments: StoredPlanComment[]): string {
  const sections = comments.map((comment) => {
    const selected = compactSelectedText(comment.review.anchor.selectedText);
    return `[${comment.displayId}] “${selected}”\n${comment.review.body.trim()}`;
  });

  return `Revise the plan using this review:\n\n${sections.join("\n\n")}`;
}

export function compileCodeReview(comments: StoredCodeComment[]): string {
  const sections = comments.map((comment) => {
    const anchor = comment.review.anchor;
    const location = `${anchor.relativePath ?? anchor.documentUri}:${anchor.range.startLine + 1}`;
    const quote = quoteSelectedText(anchor.selectedText);
    return `[${comment.displayId}] ${location}\n${quote}\n\n${comment.review.body.trim()}`;
  });

  return `Address this code review:\n\n${sections.join("\n\n")}`;
}

function compactSelectedText(text: string): string {
  const normalized = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" / ");

  if (normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 157)}...`;
}

function quoteSelectedText(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.map((line) => `> ${line}`).join("\n");
}
