import * as vscode from "vscode";
import { PiCommentController } from "./comment-controller";
import { CommentStore } from "./comment-store";
import { createInstanceEntry, deleteRegistryEntry, writeRegistryEntry } from "./instance-registry";
import { getActiveCodeReviewTarget } from "./diff-resolver";
import { registerFileUriHandler } from "./file-uri-handler";
import { PlanStore } from "./plan-store";
import { compileCodeReview, compilePlanReview } from "./review-compiler";
import { SocketServer } from "./socket-server";
import { PiStatusBar } from "./status-bar";

let server: SocketServer | undefined;
let registryInstanceId: string | undefined;
let statusBar: PiStatusBar | undefined;
let planStore: PlanStore | undefined;
let commentController: PiCommentController | undefined;
let sendingPlanReview = false;
let sendingCodeReview = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusBar = new PiStatusBar();
  context.subscriptions.push(statusBar);

  planStore = new PlanStore(context);
  await planStore.restore();

  const commentStore = new CommentStore(context);
  commentController = new PiCommentController(planStore, commentStore);
  await commentController.restore();
  commentController.registerCommands(context);
  context.subscriptions.push(commentController);

  const entry = createInstanceEntry();
  registryInstanceId = entry.instanceId;

  server = new SocketServer(entry, planStore, (connected) => statusBar?.update(connected));
  await server.start();
  await writeRegistryEntry(entry);

  context.subscriptions.push(server, registerFileUriHandler());

  context.subscriptions.push(
    vscode.commands.registerCommand("piReview.sendTestPrefill", async () => {
      if (!server?.connectedPi) {
        vscode.window.showErrorMessage("No Pi session is connected. Run /vscode-connect in the master Pi terminal.");
        return;
      }

      try {
        const result = await server.sendPrefill("Test review from VS Code.");
        if (!result.ok) {
          vscode.window.showErrorMessage(result.message ?? "Pi rejected the prefill.");
          return;
        }
        vscode.window.showInformationMessage(result.queued ? "Review queued in Pi." : "Review inserted into Pi input.");
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand("piReview.sendPlanReview", async () => sendPlanReview()),
    vscode.commands.registerCommand("piReview.sendCodeReview", async () => sendCodeReview()),
    vscode.commands.registerCommand("piReview.showConnection", () => statusBar?.showConnection()),
    vscode.commands.registerCommand("piReview.disconnect", () => {
      if (!server?.connectedPi) {
        vscode.window.showInformationMessage("Pi is already disconnected.");
        return;
      }
      server.disconnect();
      vscode.window.showInformationMessage("Pi disconnected.");
    }),
  );

  const updateActiveContexts = async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    void vscode.commands.executeCommand("setContext", "piReview.activePlan", Boolean(uri && planStore?.isPublishedPlan(uri)));
    void vscode.commands.executeCommand("setContext", "piReview.activeDiff", Boolean(await getActiveCodeReviewTarget()));
  };
  void updateActiveContexts();
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => void updateActiveContexts()));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => void updateActiveContexts()));
}

async function sendCodeReview(): Promise<void> {
  if (sendingCodeReview) return;

  if (!server?.connectedPi) {
    vscode.window.showErrorMessage("No Pi session is connected. Run /vscode-connect in the master Pi terminal.");
    return;
  }

  const target = await getActiveCodeReviewTarget();
  if (!target) {
    vscode.window.showErrorMessage("Open a text diff or an added Git file before sending a code review.");
    return;
  }

  const comments = commentController?.getUnresolvedCodeComments(target) ?? [];
  if (comments.length === 0) {
    vscode.window.showErrorMessage("There are no unresolved comments on the active code review.");
    return;
  }

  sendingCodeReview = true;
  try {
    const result = await server.sendPrefill(compileCodeReview(comments));
    if (!result.ok) {
      vscode.window.showErrorMessage(result.message ?? "Pi rejected the code review.");
      return;
    }

    await commentController?.markSent(comments.map((comment) => comment.id));
    vscode.window.showInformationMessage(result.queued ? "Code review queued in Pi." : "Code review inserted into Pi input.");
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  } finally {
    sendingCodeReview = false;
  }
}

async function sendPlanReview(): Promise<void> {
  if (sendingPlanReview) return;

  if (!server?.connectedPi) {
    vscode.window.showErrorMessage("No Pi session is connected. Run /vscode-connect in the master Pi terminal.");
    return;
  }

  const uri = vscode.window.activeTextEditor?.document.uri;
  const metadata = uri ? planStore?.getMetadata(uri) : undefined;
  if (!uri || !metadata) {
    vscode.window.showErrorMessage("Open a published Pi plan before sending a plan review.");
    return;
  }

  const comments = commentController?.getUnresolvedPlanComments(metadata.planId, metadata.version) ?? [];
  if (comments.length === 0) {
    vscode.window.showErrorMessage("There are no unresolved comments on this plan version.");
    return;
  }

  sendingPlanReview = true;
  try {
    const result = await server.sendPrefill(compilePlanReview(comments));
    if (!result.ok) {
      vscode.window.showErrorMessage(result.message ?? "Pi rejected the plan review.");
      return;
    }

    await commentController?.markSent(comments.map((comment) => comment.id));
    vscode.window.showInformationMessage(result.queued ? "Plan review queued in Pi." : "Plan review inserted into Pi input.");
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  } finally {
    sendingPlanReview = false;
  }
}

export async function deactivate(): Promise<void> {
  server?.dispose();
  server = undefined;
  if (registryInstanceId) {
    await deleteRegistryEntry(registryInstanceId);
    registryInstanceId = undefined;
  }
  statusBar?.dispose();
  statusBar = undefined;
  commentController?.dispose();
  commentController = undefined;
  planStore = undefined;
}
