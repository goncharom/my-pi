import * as vscode from "vscode";
import { CommentStore, type StoredPlanComment, type StoredReviewComment, type StoredCodeComment } from "./comment-store";
import { captureTextAnchor, deserializeRange } from "./text-anchor";
import { belongsToReview, createCodeAnchor, findReviewFile, getActiveChangesReview, type ChangesReview } from "./changes-review";
import type { PlanStore } from "./plan-store";
import type { PlanAnchor, ReviewIntent } from "../../pi-extension/src/protocol";

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
  private refreshGeneration = 0;
  private rangeContext?: { tab: vscode.Tab | undefined; reviewKey: string | undefined };
  private disposed = false;

  constructor(
    private readonly planStore: PlanStore,
    private readonly commentStore: CommentStore,
  ) {
    this.controller = vscode.comments.createCommentController("piReview", "Pi Review");
    this.controller.options = {
      prompt: "Add Pi review feedback",
      placeHolder: "Request a change or ask Pi a question...",
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: async (document) => {
        if (!this.planStore.isPublishedPlan(document.uri)) {
          const review = await getActiveChangesReview(document.uri);
          if (!review || !findReviewFile(review, document.uri)) return [];
        }
        return [new vscode.Range(0, 0, Math.max(document.lineCount - 1, 0), 0)];
      },
    };
    const refresh = () => void this.refreshCodeThreads();
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(refresh),
      vscode.window.tabGroups.onDidChangeTabGroups(refresh),
      vscode.window.onDidChangeActiveTextEditor(refresh),
    );
  }

  async restore(): Promise<void> {
    const comments = await this.commentStore.load();
    for (const comment of comments) {
      if (comment.review.kind === "plan") this.createOrUpdateThread(comment);
    }
    await this.refreshCodeThreads();
  }

  private async refreshCodeThreads(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const review = await getActiveChangesReview();
    if (this.disposed || generation !== this.refreshGeneration) return;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const reviewKey = review && JSON.stringify([review.repositoryRoot, review.originalRef, review.modifiedRef]);
    if (!this.rangeContext || this.rangeContext.tab !== tab || this.rangeContext.reviewKey !== reviewKey) {
      this.rangeContext = { tab, reviewKey };
      // Refresh stale gutters only when the review context changes. Reassigning
      // this provider rebuilds comment widgets, so doing it on comment-input
      // focus changes would destroy the editor the user is trying to type in.
      this.controller.commentingRangeProvider = this.controller.commentingRangeProvider;
    }
    for (const stored of this.commentStore.all()) {
      if (stored.review.kind !== "code") continue;
      if (review && belongsToReview(stored.review.anchor, review)) {
        if (!this.threads.has(stored.id)) this.createOrUpdateThread(stored);
      } else {
        this.threads.get(stored.id)?.dispose();
        this.threads.delete(stored.id);
      }
    }
  }

  registerCommands(context: vscode.ExtensionContext): void {
    const registrations = [
      vscode.commands.registerCommand("piReview.addComment", async (reply: vscode.CommentReply) => this.addComment(reply, "change")),
      vscode.commands.registerCommand("piReview.addQuestion", async (reply: vscode.CommentReply) => this.addComment(reply, "question")),
      vscode.commands.registerCommand("piReview.editComment", async (comment: PiReviewComment) => this.editComment(comment)),
      vscode.commands.registerCommand("piReview.deleteComment", async (arg: vscode.CommentThread | PiReviewComment) => this.deleteComment(arg)),
    ];
    context.subscriptions.push(...registrations);
    this.disposables.push(...registrations);
  }

  getPlanComments(planId: string, version: number): StoredPlanComment[] {
    return this.commentStore.getByPlan(planId, version);
  }

  getCodeComments(review: ChangesReview): StoredCodeComment[] {
    return this.commentStore.getByChangesReview(review);
  }

  private async addComment(reply: vscode.CommentReply, intent: ReviewIntent): Promise<void> {
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
      const stored = await this.commentStore.createPlan({ uri: thread.uri.toString(), body: text, intent, anchor });
      this.createOrUpdateThread(stored, thread);
      return;
    }

    const review = await getActiveChangesReview(thread.uri);
    if (review && findReviewFile(review, thread.uri)) {
      const anchor = await createCodeAnchor(thread.uri, thread.range, review);
      const stored = await this.commentStore.createCode({ uri: thread.uri.toString(), body: text, intent, anchor });
      const activeReview = await getActiveChangesReview();
      if (!this.disposed && activeReview && belongsToReview(stored.review.anchor, activeReview)) {
        this.createOrUpdateThread(stored, thread);
      } else {
        thread.dispose();
      }
      return;
    }

    vscode.window.showErrorMessage("Open a commit with Open Changes to add code review comments, or open a published Pi plan.");
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
    if (updated) this.refreshThread(updated.id);
  }

  private async deleteComment(arg: vscode.CommentThread | PiReviewComment): Promise<void> {
    const id = isPiReviewComment(arg) ? arg.id : this.threadIds.get(arg);
    if (!id) return;

    await this.commentStore.delete(id);
    const thread = this.threads.get(id);
    thread?.dispose();
    this.threads.delete(id);
  }

  private createOrUpdateThread(stored: StoredReviewComment, existingThread?: vscode.CommentThread): vscode.CommentThread {
    const range = deserializeRange(stored.review.anchor.range);
    const thread = existingThread ?? this.threads.get(stored.id) ?? this.controller.createCommentThread(vscode.Uri.parse(stored.uri), range, []);

    this.threadIds.set(thread, stored.id);
    this.threads.set(stored.id, thread);
    thread.range = range;
    thread.canReply = false;
    const label = intentLabel(stored.review.intent);
    thread.label = [stored.displayId, label].filter(Boolean).join(" · ");
    thread.contextValue = "piReviewThread";
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    thread.comments = [new PiReviewComment(stored.id, stored.review.body, label, new Date(stored.updatedAt))];
    return thread;
  }

  private refreshThread(id: string): void {
    const stored = this.commentStore.get(id);
    if (!stored) return;
    if (stored.review.kind === "plan" || this.threads.has(id)) this.createOrUpdateThread(stored);
  }

  private async createPlanAnchor(uri: vscode.Uri, range: vscode.Range | undefined): Promise<PlanAnchor> {
    const metadata = this.planStore.getMetadata(uri);
    if (!metadata) throw new Error("No published plan metadata found for this document.");

    const document = await vscode.workspace.openTextDocument(uri);
    return {
      kind: "plan",
      planId: metadata.planId,
      planVersion: metadata.version,
      documentHash: metadata.documentHash,
      ...captureTextAnchor(document, range),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.refreshGeneration++;
    for (const disposable of this.disposables) disposable.dispose();
    this.controller.dispose();
  }
}

function intentLabel(intent: ReviewIntent): string | undefined {
  return intent === "question" ? "question" : undefined;
}

function isPiReviewComment(value: unknown): value is PiReviewComment {
  return value instanceof PiReviewComment || Boolean(value && typeof value === "object" && typeof (value as PiReviewComment).id === "string");
}
