import * as vscode from "vscode";
import { CommentStore, deserializeRange, serializeRange, type StoredPlanComment, type StoredReviewComment, type StoredCodeComment } from "./comment-store";
import { createCodeAnchor, findOpenTextDiffForUri, isDiffDocument, type TextDiffInput } from "./diff-resolver";
import type { PlanStore } from "./plan-store";
import type { PlanAnchor } from "../../pi-extension/src/protocol";

class PiReviewComment implements vscode.Comment {
  body: string | vscode.MarkdownString;
  mode = vscode.CommentMode.Preview;
  author = { name: "You" };
  contextValue = "piReviewComment";
  label?: string;
  timestamp?: Date;

  constructor(
    readonly id: string,
    body: string,
    label: string | undefined,
    timestamp: Date | undefined,
  ) {
    this.body = body;
    this.label = label;
    this.timestamp = timestamp;
  }
}

export class PiCommentController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly threadIds = new WeakMap<vscode.CommentThread, string>();
  private readonly threads = new Map<string, vscode.CommentThread>();

  constructor(
    private readonly planStore: PlanStore,
    private readonly commentStore: CommentStore,
  ) {
    this.controller = vscode.comments.createCommentController("piReview", "Pi Review");
    this.controller.options = {
      prompt: "Add Pi review comment",
      placeHolder: "Write review feedback for Pi...",
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (!this.planStore.isPublishedPlan(document.uri) && !isDiffDocument(document.uri)) return [];
        return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
      },
    };
  }

  async restore(): Promise<void> {
    const comments = await this.commentStore.load();
    for (const comment of comments) {
      this.createOrUpdateThread(comment);
    }
  }

  registerCommands(context: vscode.ExtensionContext): void {
    const registrations = [
      vscode.commands.registerCommand("piReview.addComment", async (reply: vscode.CommentReply) => this.addComment(reply)),
      vscode.commands.registerCommand("piReview.editComment", async (comment: PiReviewComment) => this.editComment(comment)),
      vscode.commands.registerCommand("piReview.deleteComment", async (arg: vscode.CommentThread | PiReviewComment) => this.deleteComment(arg)),
      vscode.commands.registerCommand("piReview.resolveComment", async (thread: vscode.CommentThread) => this.setThreadStatus(thread, "resolved")),
      vscode.commands.registerCommand("piReview.reopenComment", async (thread: vscode.CommentThread) => this.setThreadStatus(thread, "unresolved")),
    ];
    context.subscriptions.push(...registrations);
    this.disposables.push(...registrations);
  }

  getUnresolvedPlanComments(planId: string, version: number): StoredPlanComment[] {
    return this.commentStore.getUnresolvedByPlan(planId, version);
  }

  getUnresolvedCodeComments(diff: TextDiffInput): StoredCodeComment[] {
    return this.commentStore.getUnresolvedByDiff(diff.original, diff.modified);
  }

  async markSent(ids: string[]): Promise<void> {
    await this.commentStore.setStatus(ids, "sent");
    for (const id of ids) this.refreshThread(id);
  }

  private async addComment(reply: vscode.CommentReply): Promise<void> {
    const text = reply.text.trim();
    if (!text) {
      vscode.window.showErrorMessage("Comment text cannot be empty.");
      return;
    }

    const thread = reply.thread;
    const existingId = this.threadIds.get(thread);
    if (existingId) {
      const updated = await this.commentStore.updateBody(existingId, text);
      if (updated) this.createOrUpdateThread(updated, thread);
      return;
    }

    if (this.planStore.isPublishedPlan(thread.uri)) {
      const anchor = await this.createPlanAnchor(thread.uri, thread.range);
      const stored = await this.commentStore.createPlan({ uri: thread.uri.toString(), body: text, anchor });
      this.createOrUpdateThread(stored, thread);
      return;
    }

    const diff = findOpenTextDiffForUri(thread.uri);
    if (diff) {
      const anchor = await createCodeAnchor(thread.uri, thread.range, diff);
      const stored = await this.commentStore.createCode({ uri: thread.uri.toString(), body: text, anchor });
      this.createOrUpdateThread(stored, thread);
      return;
    }

    vscode.window.showErrorMessage("Pi Review comments are supported on published plans and open text diffs.");
    thread.dispose();
  }

  private async editComment(comment: PiReviewComment): Promise<void> {
    const stored = this.commentStore.get(comment.id);
    if (!stored) return;

    const next = await vscode.window.showInputBox({
      title: `Edit ${stored.displayId}`,
      value: stored.review.body,
      prompt: "Update Pi review comment",
      ignoreFocusOut: true,
    });
    if (next === undefined) return;
    if (next.trim() === "") {
      vscode.window.showErrorMessage("Comment text cannot be empty.");
      return;
    }

    const updated = await this.commentStore.updateBody(stored.id, next.trim());
    if (updated) this.createOrUpdateThread(updated);
  }

  private async deleteComment(arg: vscode.CommentThread | PiReviewComment): Promise<void> {
    const id = isPiReviewComment(arg) ? arg.id : this.threadIds.get(arg);
    if (!id) return;

    await this.commentStore.delete(id);
    const thread = this.threads.get(id);
    thread?.dispose();
    this.threads.delete(id);
  }

  private async setThreadStatus(thread: vscode.CommentThread, status: "resolved" | "unresolved"): Promise<void> {
    const id = this.threadIds.get(thread);
    if (!id) return;
    await this.commentStore.setStatus([id], status);
    this.refreshThread(id);
  }

  private createOrUpdateThread(stored: StoredReviewComment, existingThread?: vscode.CommentThread): vscode.CommentThread {
    const range = deserializeRange(stored.review.anchor.range);
    const thread = existingThread ?? this.threads.get(stored.id) ?? this.controller.createCommentThread(vscode.Uri.parse(stored.uri), range, []);

    this.threadIds.set(thread, stored.id);
    this.threads.set(stored.id, thread);
    thread.range = range;
    thread.canReply = false;
    thread.label = `${stored.displayId} ${statusLabel(stored.review.status)}`.trim();
    thread.contextValue = `piReviewThread.${stored.review.status}`;
    thread.state = stored.review.status === "resolved" ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    thread.comments = [new PiReviewComment(stored.id, stored.review.body, statusLabel(stored.review.status), new Date(stored.updatedAt))];
    return thread;
  }

  private refreshThread(id: string): void {
    const stored = this.commentStore.get(id);
    if (!stored) return;
    this.createOrUpdateThread(stored);
  }

  private async createPlanAnchor(uri: vscode.Uri, range: vscode.Range | undefined): Promise<PlanAnchor> {
    const metadata = this.planStore.getMetadata(uri);
    if (!metadata) throw new Error("No published plan metadata found for this document.");

    const document = await vscode.workspace.openTextDocument(uri);
    const normalizedRange = normalizeRange(document, range);
    const selectedText = selectedTextForRange(document, normalizedRange);

    return {
      kind: "plan",
      planId: metadata.planId,
      planVersion: metadata.version,
      documentHash: metadata.documentHash,
      range: serializeRange(normalizedRange),
      selectedText,
      linesBefore: linesBefore(document, normalizedRange.start.line),
      linesAfter: linesAfter(document, normalizedRange.end.line),
    };
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.controller.dispose();
  }
}

function normalizeRange(document: vscode.TextDocument, range: vscode.Range | undefined): vscode.Range {
  if (!range) return new vscode.Range(0, 0, 0, 0);
  if (!range.isEmpty) return range;
  const line = document.lineAt(Math.min(range.start.line, document.lineCount - 1));
  return line.range;
}

function selectedTextForRange(document: vscode.TextDocument, range: vscode.Range): string {
  const text = document.getText(range).trimEnd();
  if (text.length > 0) return text;
  return document.lineAt(Math.min(range.start.line, document.lineCount - 1)).text;
}

function linesBefore(document: vscode.TextDocument, startLine: number): string[] {
  const first = Math.max(0, startLine - 3);
  const lines: string[] = [];
  for (let line = first; line < startLine; line += 1) lines.push(document.lineAt(line).text);
  return lines;
}

function linesAfter(document: vscode.TextDocument, endLine: number): string[] {
  const last = Math.min(document.lineCount - 1, endLine + 3);
  const lines: string[] = [];
  for (let line = endLine + 1; line <= last; line += 1) lines.push(document.lineAt(line).text);
  return lines;
}

function statusLabel(status: StoredReviewComment["review"]["status"]): string | undefined {
  if (status === "sent") return "sent";
  if (status === "resolved") return "resolved";
  return undefined;
}

function isPiReviewComment(value: unknown): value is PiReviewComment {
  return value instanceof PiReviewComment || Boolean(value && typeof value === "object" && typeof (value as PiReviewComment).id === "string");
}
