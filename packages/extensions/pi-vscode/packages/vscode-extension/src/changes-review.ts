import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CodeAnchor } from "../../pi-extension/src/protocol";
import { captureTextAnchor } from "./text-anchor";
import { readCommitChanges, type CommitChangesSeed } from "./git-commit-changes";
import { parseGitUri } from "./git-uri-adapter";

export interface ChangesReviewFile {
  original?: vscode.Uri;
  modified?: vscode.Uri;
}

export interface ChangesReview {
  repositoryRoot: string;
  originalRef: string;
  modifiedRef: string;
  files: ChangesReviewFile[];
}

interface MultiDiffInput {
  textDiffs: readonly ChangesReviewFile[];
}

const reviews = new WeakMap<vscode.Tab, { input: MultiDiffInput; pending: Promise<ChangesReview | undefined> }>();

/**
 * textDiffs is exposed by the extension host, but its named class is still proposed.
 * Keep that compatibility boundary here; never treat a standalone TextDiff as a review.
 */
function asMultiDiffInput(input: unknown): MultiDiffInput | undefined {
  if (!input || typeof input !== "object" || !("textDiffs" in input) || !Array.isArray(input.textDiffs)) return undefined;
  if (!input.textDiffs.every((file: ChangesReviewFile) => file &&
    (file.original === undefined || file.original instanceof vscode.Uri) &&
    (file.modified === undefined || file.modified instanceof vscode.Uri))) return undefined;
  return input as MultiDiffInput;
}

export async function getActiveChangesReview(documentUri?: vscode.Uri): Promise<ChangesReview | undefined> {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = asMultiDiffInput(tab?.input);
  if (!tab || !input) return undefined;

  let cached = reviews.get(tab);
  if (cached?.input !== input) {
    const seed = reviewSeed(tab, input, documentUri);
    if (!seed) return undefined;
    const pending = readCommitChanges(seed).then((changes): ChangesReview => ({
      ...changes,
      files: changes.files.map((file) => ({
        original: file.originalPath ? gitUri(changes.repositoryRoot, file.originalPath, changes.originalRef) : undefined,
        modified: file.modifiedPath ? gitUri(changes.repositoryRoot, file.modifiedPath, changes.modifiedRef) : undefined,
      })),
    })).catch(() => undefined);
    cached = { input, pending };
    reviews.set(tab, cached);
  }

  const review = await cached.pending;
  // Do not use a result belonging to a tab that stopped being active during Git I/O.
  if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab || tab.input !== input) return undefined;
  if (!review) reviews.delete(tab); // A transient Git error must not poison the tab's cache.
  return review;
}

function reviewSeed(tab: vscode.Tab, input: MultiDiffInput, documentUri?: vscode.Uri): CommitChangesSeed | undefined {
  for (const file of input.textDiffs) {
    const original = file.original && parseGitUri(file.original);
    const modified = file.modified && parseGitUri(file.modified);
    if (original && modified && isObjectId(original.ref) && isObjectId(modified.ref)) {
      return { ...modified, originalRef: original.ref, modifiedRef: modified.ref };
    }
  }

  // VS Code currently omits one-sided entries from textDiffs. For add/delete-only
  // commits, its Git history editor title is "<commit id> - <subject>". Resolve that
  // id in the displayed document's repository, not an unrelated workspace root.
  const commitId = /^([a-f\d]{4,64})\s+-\s/i.exec(tab.label)?.[1];
  if (!commitId || input.textDiffs.length > 0) return undefined;
  const candidates = [documentUri, vscode.window.activeTextEditor?.document.uri,
    ...vscode.window.visibleTextEditors.map((editor) => editor.document.uri)];
  for (const uri of candidates) {
    const info = uri && parseGitUri(uri);
    if (info && isObjectId(info.ref)) return { ...info, modifiedRef: commitId };
  }
  return undefined;
}

function isObjectId(ref: string | undefined): ref is string {
  return Boolean(ref && /^[a-f\d]{40,64}$/i.test(ref));
}

function gitUri(root: string, relativePath: string, ref: string): vscode.Uri {
  const uri = vscode.Uri.file(path.join(root, relativePath));
  return uri.with({ scheme: "git", query: JSON.stringify({ path: uri.fsPath, ref }) });
}

export function findReviewFile(review: ChangesReview, uri: vscode.Uri): ChangesReviewFile | undefined {
  const key = uri.toString();
  return review.files.find((file) => file.original?.toString() === key || file.modified?.toString() === key);
}

export function belongsToReview(anchor: CodeAnchor, review: ChangesReview): boolean {
  return anchor.repositoryRoot === review.repositoryRoot &&
    anchor.originalRef === review.originalRef && anchor.modifiedRef === review.modifiedRef &&
    Boolean(findReviewFile(review, vscode.Uri.parse(anchor.documentUri)));
}

export async function createCodeAnchor(uri: vscode.Uri, range: vscode.Range | undefined, review: ChangesReview): Promise<CodeAnchor> {
  const file = findReviewFile(review, uri);
  if (!file) throw new Error("The commented document is not part of the active Changes review.");
  const side = file.modified?.toString() === uri.toString() ? "modified" : "original";
  const document = await vscode.workspace.openTextDocument(uri);
  const info = parseGitUri(uri)!;
  return {
    kind: "code", documentUri: uri.toString(), repositoryRoot: review.repositoryRoot,
    relativePath: path.relative(review.repositoryRoot, info.filePath), side,
    originalRef: review.originalRef, modifiedRef: review.modifiedRef,
    documentHash: crypto.createHash("sha256").update(document.getText(), "utf8").digest("hex"),
    ...captureTextAnchor(document, range),
  };
}
