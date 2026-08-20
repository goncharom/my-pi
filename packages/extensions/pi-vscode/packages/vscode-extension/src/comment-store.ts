import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CodeAnchor, PlanAnchor, ReviewComment, SerializedRange } from "../../pi-extension/src/protocol";
import type { CodeReviewTarget } from "./diff-resolver";

export interface StoredPlanComment {
  id: string;
  uri: string;
  displayId: string;
  review: ReviewComment & { kind: "plan"; anchor: PlanAnchor };
  createdAt: string;
  updatedAt: string;
}

export interface StoredCodeComment {
  id: string;
  uri: string;
  displayId: string;
  review: ReviewComment & { kind: "code"; anchor: CodeAnchor };
  createdAt: string;
  updatedAt: string;
}

export type StoredReviewComment = StoredPlanComment | StoredCodeComment;

interface CommentStoreFile {
  comments: StoredReviewComment[];
}

export class CommentStore {
  private comments = new Map<string, StoredReviewComment>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async load(): Promise<StoredReviewComment[]> {
    this.comments.clear();
    try {
      const raw = await fs.readFile(this.filePath(), "utf8");
      const data = JSON.parse(raw) as CommentStoreFile;
      for (const comment of data.comments ?? []) {
        if (isStoredReviewComment(comment)) this.comments.set(comment.id, comment);
      }
    } catch {
      // Missing or corrupt comment state starts empty for the MVP.
    }
    return this.all();
  }

  all(): StoredReviewComment[] {
    return [...this.comments.values()].sort((a, b) => a.displayId.localeCompare(b.displayId, undefined, { numeric: true }));
  }

  get(id: string): StoredReviewComment | undefined {
    return this.comments.get(id);
  }

  getByPlan(planId: string, version: number): StoredPlanComment[] {
    return this.all().filter(
      (comment): comment is StoredPlanComment =>
        comment.review.kind === "plan" &&
        comment.review.anchor.planId === planId &&
        comment.review.anchor.planVersion === version,
    );
  }

  getUnresolvedByPlan(planId: string, version: number): StoredPlanComment[] {
    return this.getByPlan(planId, version).filter((comment) => comment.review.status === "unresolved");
  }

  getUnresolvedByCodeReviewTarget(target: CodeReviewTarget): StoredCodeComment[] {
    const originalUri = target.original?.toString();
    const modifiedUri = target.modified.toString();
    return this.all().filter(
      (comment): comment is StoredCodeComment =>
        comment.review.kind === "code" &&
        comment.review.status === "unresolved" &&
        (comment.review.anchor.documentUri === originalUri || comment.review.anchor.documentUri === modifiedUri),
    );
  }

  async createPlan(input: { uri: string; body: string; anchor: PlanAnchor }): Promise<StoredPlanComment> {
    const id = this.nextDisplayId("P");
    const now = new Date().toISOString();
    const stored: StoredPlanComment = {
      id,
      uri: input.uri,
      displayId: id,
      review: {
        id,
        kind: "plan",
        body: input.body,
        status: "unresolved",
        anchor: input.anchor,
      },
      createdAt: now,
      updatedAt: now,
    };
    this.comments.set(id, stored);
    await this.save();
    return stored;
  }

  async createCode(input: { uri: string; body: string; anchor: CodeAnchor }): Promise<StoredCodeComment> {
    const id = this.nextDisplayId("C");
    const now = new Date().toISOString();
    const stored: StoredCodeComment = {
      id,
      uri: input.uri,
      displayId: id,
      review: {
        id,
        kind: "code",
        body: input.body,
        status: "unresolved",
        anchor: input.anchor,
      },
      createdAt: now,
      updatedAt: now,
    };
    this.comments.set(id, stored);
    await this.save();
    return stored;
  }

  async updateBody(id: string, body: string): Promise<StoredReviewComment | undefined> {
    const stored = this.comments.get(id);
    if (!stored) return undefined;
    stored.review.body = body;
    if (stored.review.status === "sent") stored.review.status = "unresolved";
    stored.updatedAt = new Date().toISOString();
    await this.save();
    return stored;
  }

  async setStatus(ids: string[], status: ReviewComment["status"]): Promise<void> {
    const now = new Date().toISOString();
    for (const id of ids) {
      const stored = this.comments.get(id);
      if (!stored) continue;
      stored.review.status = status;
      stored.updatedAt = now;
    }
    await this.save();
  }

  async delete(id: string): Promise<void> {
    this.comments.delete(id);
    await this.save();
  }

  private nextDisplayId(prefix: "P" | "C"): string {
    let max = 0;
    for (const comment of this.comments.values()) {
      const match = new RegExp(`^${prefix}(\\d+)$`).exec(comment.displayId);
      if (match) max = Math.max(max, Number.parseInt(match[1], 10));
    }
    return `${prefix}${max + 1}`;
  }

  private async save(): Promise<void> {
    const filePath = this.filePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify({ comments: this.all() }, null, 2)}\n`, "utf8");
    await fs.rename(temp, filePath);
  }

  private filePath(): string {
    const storageUri = this.context.storageUri ?? this.context.globalStorageUri;
    return path.join(storageUri.fsPath, "comments.json");
  }
}

export function serializeRange(range: vscode.Range): SerializedRange {
  return {
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  };
}

export function deserializeRange(range: SerializedRange): vscode.Range {
  return new vscode.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter);
}

function isStoredReviewComment(value: unknown): value is StoredReviewComment {
  if (!value || typeof value !== "object") return false;
  const comment = value as Partial<StoredReviewComment>;
  const review = comment.review as Partial<ReviewComment> | undefined;
  const anchor = review?.anchor as Partial<PlanAnchor | CodeAnchor> | undefined;
  return (
    typeof comment.id === "string" &&
    typeof comment.uri === "string" &&
    typeof comment.displayId === "string" &&
    typeof review?.body === "string" &&
    (review.kind === "plan" || review.kind === "code") &&
    anchor?.kind === review.kind
  );
}
