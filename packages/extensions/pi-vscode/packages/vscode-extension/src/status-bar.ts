import * as vscode from "vscode";
import type { ConnectedPi } from "./socket-server";

export class PiStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private connected?: ConnectedPi;

  constructor() {
    this.item.command = "piReview.showConnection";
    this.update(undefined);
    this.item.show();
  }

  update(connected: ConnectedPi | undefined): void {
    this.connected = connected;

    if (!connected) {
      this.item.text = "$(debug-disconnect) Pi disconnected";
      this.item.tooltip = "No Pi session is connected. Run /vscode-connect in the master Pi terminal.";
      return;
    }

    this.item.text = "$(plug) Pi connected";
    this.item.tooltip = [
      `Session: ${connected.sessionName ?? `PID ${connected.pid}`}`,
      `Working directory: ${connected.cwd}`,
      `Connected since: ${new Date(connected.connectedAt).toLocaleString()}`,
    ].join("\n");
  }

  showConnection(): void {
    if (!this.connected) {
      vscode.window.showInformationMessage("No Pi session is connected. Run /vscode-connect in the master Pi terminal.");
      return;
    }

    vscode.window.showInformationMessage(
      `Pi connected: ${this.connected.sessionName ?? `PID ${this.connected.pid}`} (${this.connected.cwd})`,
    );
  }

  dispose(): void {
    this.item.dispose();
  }
}
