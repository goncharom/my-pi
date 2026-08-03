import * as path from "node:path";
import * as vscode from "vscode";

export function registerFileUriHandler(): vscode.Disposable {
  return vscode.window.registerUriHandler({
    handleUri: async (uri) => {
      if (uri.path !== "/open") {
        vscode.window.showErrorMessage("Unsupported Pi Review link.");
        return;
      }

      const query = new URLSearchParams(uri.query);
      const filePath = query.get("path");
      if (!filePath || !path.isAbsolute(filePath)) {
        vscode.window.showErrorMessage("Invalid Pi Review file link.");
        return;
      }

      const position = new vscode.Position(
        Math.max(0, positiveNumber(query.get("line")) - 1),
        Math.max(0, positiveNumber(query.get("column")) - 1),
      );

      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
        await vscode.window.showTextDocument(document, {
          preview: false,
          selection: new vscode.Range(position, position),
        });
      } catch (error) {
        vscode.window.showErrorMessage(`Could not open Pi file link: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}

function positiveNumber(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}
