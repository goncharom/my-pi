import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CodeAnchor } from "../../pi-extension/src/protocol";
import { serializeRange } from "./comment-store";
import { isAddedGitRevisionDocument } from "./git-change-resolver";
import { parseGitUri } from "./git-uri-adapter";

export interface CodeReviewTarget {
  original?: vscode.Uri;
  modified: vscode.Uri;
}

export interface DiffIdentity {
  repositoryRoot?: string;
  relativePath?: string;
  side: "original" | "modified";
  originalRef?: string;
  modifiedRef?: string;
}

export function getActiveTextDiff(): CodeReviewTarget | undefined {
  return asTextDiffInput(vscode.window.tabGroups.activeTabGroup.activeTab?.input);
}

export async function getActiveCodeReviewTarget(): Promise<CodeReviewTarget | undefined> {
  const diff = getActiveTextDiff();
  if (diff) return diff;

  const uri = vscode.window.activeTextEditor?.document.uri;
  if (uri && await isAddedGitRevisionDocument(uri)) return { modified: uri };
  return undefined;
}

export function getOpenTextDiffs(): CodeReviewTarget[] {
  const diffs: CodeReviewTarget[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = asTextDiffInput(tab.input);
      if (input) diffs.push(input);
    }
  }
  return diffs;
}

export function findOpenTextDiffForUri(uri: vscode.Uri): CodeReviewTarget | undefined {
  const key = uri.toString();
  return getOpenTextDiffs().find((diff) => diff.original?.toString() === key || diff.modified.toString() === key);
}

export async function findCodeReviewTargetForUri(uri: vscode.Uri): Promise<CodeReviewTarget | undefined> {
  const diff = findOpenTextDiffForUri(uri);
  if (diff) return diff;
  if (await isAddedGitRevisionDocument(uri)) return { modified: uri };
  return undefined;
}

export async function isCodeReviewDocument(uri: vscode.Uri): Promise<boolean> {
  return Boolean(await findCodeReviewTargetForUri(uri));
}

export function diffSideForUri(diff: CodeReviewTarget, uri: vscode.Uri): "original" | "modified" | undefined {
  const key = uri.toString();
  if (diff.modified.toString() === key) return "modified";
  if (diff.original?.toString() === key) return "original";
  return undefined;
}

export async function createCodeAnchor(uri: vscode.Uri, range: vscode.Range | undefined, diff: CodeReviewTarget): Promise<CodeAnchor> {
  const side = diffSideForUri(diff, uri);
  if (!side) throw new Error("The commented document is not part of the active code review.");

  const document = await vscode.workspace.openTextDocument(uri);
  const normalizedRange = normalizeRange(document, range);
  const identity = resolveDiffIdentity(uri, side, diff);

  return {
    kind: "code",
    documentUri: uri.toString(),
    repositoryRoot: identity.repositoryRoot,
    relativePath: identity.relativePath,
    side: identity.side,
    originalRef: identity.originalRef,
    modifiedRef: identity.modifiedRef,
    documentHash: hashText(document.getText()),
    range: serializeRange(normalizedRange),
    selectedText: selectedTextForRange(document, normalizedRange),
    linesBefore: linesBefore(document, normalizedRange.start.line),
    linesAfter: linesAfter(document, normalizedRange.end.line),
  };
}

function asTextDiffInput(input: unknown): CodeReviewTarget | undefined {
  if (input instanceof vscode.TabInputTextDiff) {
    return { original: input.original, modified: input.modified };
  }

  const maybe = input as Partial<CodeReviewTarget> | undefined;
  if (maybe?.original instanceof vscode.Uri && maybe.modified instanceof vscode.Uri) {
    return { original: maybe.original, modified: maybe.modified };
  }
  return undefined;
}

function resolveDiffIdentity(uri: vscode.Uri, side: "original" | "modified", diff: CodeReviewTarget): DiffIdentity {
  const base: DiffIdentity = { side };
  const gitInfo = parseGitUri(uri);
  const originalGitInfo = diff.original ? parseGitUri(diff.original) : undefined;
  if (gitInfo) {
    return {
      ...base,
      repositoryRoot: gitInfo.repositoryRoot,
      relativePath: gitInfo.relativePath,
      originalRef: side === "original" ? gitInfo.ref : originalGitInfo?.ref,
      modifiedRef: side === "modified" ? gitInfo.ref : parseGitUri(diff.modified)?.ref,
    };
  }

  const workspace = uri.scheme === "file" ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
  if (workspace) {
    return {
      ...base,
      repositoryRoot: workspace.uri.fsPath,
      relativePath: path.relative(workspace.uri.fsPath, uri.fsPath),
      originalRef: originalGitInfo?.ref,
      modifiedRef: parseGitUri(diff.modified)?.ref,
    };
  }

  return {
    ...base,
    originalRef: originalGitInfo?.ref,
    modifiedRef: parseGitUri(diff.modified)?.ref,
  };
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

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
