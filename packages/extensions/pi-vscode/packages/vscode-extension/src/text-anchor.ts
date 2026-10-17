import * as vscode from "vscode";
import type { PlanAnchor, SerializedRange } from "../../pi-extension/src/protocol";

/** Capture the same selected text and nearby context for plan and code comments. */
export function captureTextAnchor(
  document: vscode.TextDocument,
  range: vscode.Range | undefined,
): Pick<PlanAnchor, "range" | "selectedText" | "linesBefore" | "linesAfter"> {
  const normalized = !range ? new vscode.Range(0, 0, 0, 0) : range.isEmpty
    ? document.lineAt(Math.min(range.start.line, document.lineCount - 1)).range : range;
  const linesBefore: string[] = [];
  const linesAfter: string[] = [];
  for (let line = Math.max(0, normalized.start.line - 3); line < normalized.start.line; line++) {
    linesBefore.push(document.lineAt(line).text);
  }
  for (let line = normalized.end.line + 1; line <= Math.min(document.lineCount - 1, normalized.end.line + 3); line++) {
    linesAfter.push(document.lineAt(line).text);
  }
  return {
    range: {
      startLine: normalized.start.line, startCharacter: normalized.start.character,
      endLine: normalized.end.line, endCharacter: normalized.end.character,
    },
    selectedText: document.getText(normalized).trimEnd() || document.lineAt(normalized.start.line).text,
    linesBefore, linesAfter,
  };
}

export function deserializeRange(range: SerializedRange): vscode.Range {
  return new vscode.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter);
}
