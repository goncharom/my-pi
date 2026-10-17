import * as vscode from "vscode";
import { PiCommentController } from "./comment-controller";
import { CommentStore } from "./comment-store";
import { createInstanceEntry, deleteRegistryEntry, writeRegistryEntry } from "./instance-registry";
import { registerFileUriHandler } from "./file-uri-handler";
import { PlanStore } from "./plan-store";
import { registerSendComments } from "./send-comments";
import { SocketServer } from "./socket-server";
import { PiStatusBar } from "./status-bar";

let server: SocketServer | undefined;
let registryInstanceId: string | undefined;
let statusBar: PiStatusBar | undefined;
let commentController: PiCommentController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusBar = new PiStatusBar();
  context.subscriptions.push(statusBar);

  const planStore = new PlanStore(context);
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

  context.subscriptions.push(server, registerFileUriHandler(), registerSendComments(server, planStore, commentController));

  context.subscriptions.push(
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
}
