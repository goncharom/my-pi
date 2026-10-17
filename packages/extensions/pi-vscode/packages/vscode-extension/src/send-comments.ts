import * as vscode from "vscode";
import type { PrefillResultMessage } from "../../pi-extension/src/protocol";
import { getActiveChangesReview } from "./changes-review";
import type { PiCommentController } from "./comment-controller";
import type { PlanStore } from "./plan-store";
import { compileCodeReview, compilePlanReview } from "./review-compiler";

interface ReviewSender {
  readonly connectedPi: unknown;
  sendPrefill(text: string): Promise<PrefillResultMessage>;
}

/** One permanent toolbar action; every send is a fresh snapshot of all saved comments. */
export function registerSendComments(
  sender: ReviewSender,
  plans: PlanStore,
  comments: PiCommentController,
): vscode.Disposable {
  let sending = false;
  return vscode.commands.registerCommand("piReview.sendComments", async () => {
    if (sending) return;
    if (!sender.connectedPi) {
      vscode.window.showErrorMessage("No Pi session is connected. Run /vscode-connect in the master Pi terminal.");
      return;
    }

    sending = true;
    try {
      // Comment-input focus can clear activeTextEditor. The active tab still
      // identifies the plan or Changes window the user is reviewing.
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const plan = input instanceof vscode.TabInputText ? plans.getMetadata(input.uri) : undefined;
      let text: string;
      if (plan) {
        const feedback = comments.getPlanComments(plan.planId, plan.version);
        if (feedback.length === 0) throw new Error("There are no comments on this plan version.");
        text = compilePlanReview(feedback);
      } else {
        const review = await getActiveChangesReview();
        if (!review) throw new Error("Open a commit with Open Changes or a published Pi plan before sending comments.");
        const feedback = comments.getCodeComments(review);
        if (feedback.length === 0) throw new Error("There are no comments in this Changes window.");
        text = compileCodeReview(feedback);
      }

      const result = await sender.sendPrefill(text);
      if (!result.ok) throw new Error(result.message ?? "Pi rejected the comments.");
      vscode.window.showInformationMessage(result.queued ? "Comments queued in Pi." : "Comments inserted into Pi input.");
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      sending = false;
    }
  });
}
