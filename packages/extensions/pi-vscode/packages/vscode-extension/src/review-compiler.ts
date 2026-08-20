import type { StoredCodeComment, StoredPlanComment } from "./comment-store";

export function compilePlanReview(comments: StoredPlanComment[]): string {
  const changes = comments.filter((comment) => comment.review.intent === "change").map(formatPlanComment);
  const questions = comments.filter((comment) => comment.review.intent === "question").map(formatPlanComment);

  if (questions.length === 0) {
    return `Revise the plan using this review:\n\n${changes.join("\n\n")}`;
  }

  if (changes.length === 0) {
    return `Answer these questions about the plan. Do not revise the plan solely in response to a question.\n\n${questions.join("\n\n")}`;
  }

  return [
    "Review this plan using the feedback below. Apply the requested changes and answer the questions directly. Do not revise the plan solely in response to a question.",
    `Requested changes:\n\n${changes.join("\n\n")}`,
    `Questions:\n\n${questions.join("\n\n")}`,
  ].join("\n\n");
}

export function compileCodeReview(comments: StoredCodeComment[]): string {
  const changes = comments.filter((comment) => comment.review.intent === "change").map(formatCodeComment);
  const questions = comments.filter((comment) => comment.review.intent === "question").map(formatCodeComment);

  if (questions.length === 0) {
    return `Address this code review:\n\n${changes.join("\n\n")}`;
  }

  if (changes.length === 0) {
    return `Answer these questions about the code changes. Do not modify code solely in response to a question.\n\n${questions.join("\n\n")}`;
  }

  return [
    "Review the code using the feedback below. Address the requested changes and answer the questions directly. Do not modify code solely in response to a question.",
    `Requested changes:\n\n${changes.join("\n\n")}`,
    `Questions:\n\n${questions.join("\n\n")}`,
  ].join("\n\n");
}

function formatPlanComment(comment: StoredPlanComment): string {
  const selected = compactSelectedText(comment.review.anchor.selectedText);
  return `[${comment.displayId}] “${selected}”\n${comment.review.body.trim()}`;
}

function formatCodeComment(comment: StoredCodeComment): string {
  const anchor = comment.review.anchor;
  const location = `${anchor.relativePath ?? anchor.documentUri}:${anchor.range.startLine + 1}`;
  const quote = quoteSelectedText(anchor.selectedText);
  return `[${comment.displayId}] ${location}\n${quote}\n\n${comment.review.body.trim()}`;
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
