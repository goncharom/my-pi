import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import * as vscode from "vscode";
import { belongsToReview, createCodeAnchor, findReviewFile, getActiveChangesReview } from "../src/changes-review";
import { CommentStore } from "../src/comment-store";
import { PiCommentController } from "../src/comment-controller";
import { PlanStore } from "../src/plan-store";
import { compileCodeReview } from "../src/review-compiler";

const host = vscode as any;
let root: string;
let parent: string;
let commit: string;
let addedOnly: string;
let deletedOnly: string;
let workspace: vscode.WorkspaceFolder;
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const uri = (relative: string, ref: string) => {
  const file = vscode.Uri.file(path.join(root, relative));
  return file.with({ scheme: "git", query: JSON.stringify({ path: file.fsPath, ref }) });
};
const textDiff = (relative: string) => ({ original: uri(relative, parent), modified: uri(relative, commit) });
function activate(input: unknown, documentUri?: vscode.Uri, label = "Changes") {
  const tab = { input, label };
  host.window.tabGroups.activeTabGroup = { activeTab: tab };
  host.window.tabGroups.all = [host.window.tabGroups.activeTabGroup];
  host.window.activeTextEditor = documentUri ? { document: { uri: documentUri } } : undefined;
  host.window.visibleTextEditors = host.window.activeTextEditor ? [host.window.activeTextEditor] : [];
  return tab;
}
function context(directory: string): vscode.ExtensionContext {
  return { storageUri: vscode.Uri.file(directory), globalStorageUri: vscode.Uri.file(directory), subscriptions: [] } as unknown as vscode.ExtensionContext;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-changes-review-"));
  git("init", "-q");
  git("config", "user.name", "Pi Tests");
  git("config", "user.email", "pi-tests@example.invalid");
  await fs.writeFile(path.join(root, "edit.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "delete.ts"), "delete me\n");
  await fs.writeFile(path.join(root, "old-name.ts"), "rename this exact content\n".repeat(20));
  git("add", "."); git("commit", "-qm", "Initial"); parent = git("rev-parse", "HEAD");
  await fs.writeFile(path.join(root, "edit.ts"), "export const value = 2;\n");
  await fs.writeFile(path.join(root, "new file\nwith spaces.ts"), "export const added = true;\n");
  await fs.unlink(path.join(root, "delete.ts"));
  await fs.rename(path.join(root, "old-name.ts"), path.join(root, "new-name.ts"));
  git("add", "-A"); git("commit", "-qm", "Mixed changes"); commit = git("rev-parse", "HEAD");
  await fs.mkdir(path.join(root, "new-dir"));
  await fs.writeFile(path.join(root, "new-dir", "added.ts"), "added only\n");
  git("add", "."); git("commit", "-qm", "Add only"); addedOnly = git("rev-parse", "HEAD");
  await fs.rm(path.join(root, "new-dir"), { recursive: true });
  git("add", "-A"); git("commit", "-qm", "Delete only"); deletedOnly = git("rev-parse", "HEAD");
  workspace = { uri: vscode.Uri.file(root), name: "test", index: 0 };
  host.workspace.workspaceFolders = [workspace];
  host.workspace.openTextDocument = async (documentUri: vscode.Uri) => {
    const info = JSON.parse(documentUri.query);
    const relative = path.relative(root, info.path);
    const text = execFileSync("git", ["-C", root, "show", `${info.ref}:${relative}`], { encoding: "utf8" });
    const lines = text.split("\n");
    return {
      uri: documentUri, lineCount: lines.length,
      lineAt(line: number) { return { text: lines[line], range: new vscode.Range(line, 0, line, lines[line].length) }; },
      getText(range?: vscode.Range) {
        if (!range) return text;
        if (range.start.line === range.end.line) return lines[range.start.line].slice(range.start.character, range.end.character);
        return [lines[range.start.line].slice(range.start.character), ...lines.slice(range.start.line + 1, range.end.line), lines[range.end.line].slice(0, range.end.character)].join("\n");
      },
    };
  };
});
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

test("a multi-file editor includes edits, additions, deletions, and both rename paths", async () => {
  activate({ textDiffs: [textDiff("edit.ts")] });
  const review = (await getActiveChangesReview())!;
  assert.equal(review.originalRef, parent);
  assert.equal(review.modifiedRef, commit);
  assert.equal(review.files.length, 4);
  for (const documentUri of [uri("edit.ts", parent), uri("edit.ts", commit), uri("delete.ts", parent),
    uri("new file\nwith spaces.ts", commit), uri("old-name.ts", parent), uri("new-name.ts", commit)]) {
    assert.ok(findReviewFile(review, documentUri), documentUri.toString());
    const anchor = await createCodeAnchor(documentUri, new vscode.Range(0, 0, 0, 0), review);
    assert.equal(anchor.originalRef, parent);
    assert.equal(anchor.modifiedRef, commit);
    assert.equal(anchor.repositoryRoot, root);
    assert.ok(anchor.selectedText.length > 0);
    assert.ok(belongsToReview(anchor, review));
  }
  assert.ok(!findReviewFile(review, uri("edit.ts", addedOnly)));
});

test("standalone file diffs and added-file revision editors are not review scopes", async () => {
  for (const input of [textDiff("edit.ts"), { uri: uri("new file\nwith spaces.ts", commit) }, undefined, { textDiffs: "invalid" }]) {
    activate(input, uri("new file\nwith spaces.ts", commit));
    assert.equal(await getActiveChangesReview(), undefined);
  }
  activate({ textDiffs: [{ original: vscode.Uri.file(path.join(root, "edit.ts")), modified: uri("edit.ts", commit) }] });
  assert.equal(await getActiveChangesReview(), undefined, "mixed working-tree editors are not commit reviews");
});

test("added-only, deleted-only, and root commits resolve despite empty API resource lists", async () => {
  for (const [ref, documentUri, expectedCount] of [
    [addedOnly, uri("new-dir/added.ts", addedOnly), 1],
    [deletedOnly, uri("new-dir/added.ts", addedOnly), 1],
    [parent, uri("edit.ts", parent), 3],
  ] as const) {
    activate({ textDiffs: [] }, documentUri, `${ref.slice(0, 7)} - Commit subject`);
    const review = (await getActiveChangesReview(documentUri))!;
    assert.ok(review);
    assert.equal(review.modifiedRef, ref);
    assert.equal(review.files.length, expectedCount);
    assert.ok(findReviewFile(review, documentUri));
    assert.equal(await getActiveChangesReview(), review, "sending can reuse scope without an active child editor");
  }
  activate({ textDiffs: [] }, uri("edit.ts", parent), "Not a commit editor");
  assert.equal(await getActiveChangesReview(), undefined);
});

test("a Changes editor does not need to be the only open tab, but it must be active", async () => {
  const multi = activate({ textDiffs: [textDiff("edit.ts")] });
  const single = { input: textDiff("edit.ts"), label: "edit.ts" };
  host.window.tabGroups.all = [{ activeTab: multi, tabs: [multi] }, { activeTab: single, tabs: [single] }];
  host.window.tabGroups.activeTabGroup = host.window.tabGroups.all[1];
  assert.equal(await getActiveChangesReview(), undefined);
  host.window.tabGroups.activeTabGroup = host.window.tabGroups.all[0];
  assert.ok(await getActiveChangesReview());
});

test("late Git results cannot activate a review after switching tabs", async () => {
  activate({ textDiffs: [textDiff("edit.ts")] });
  const pending = getActiveChangesReview();
  activate(textDiff("edit.ts"));
  assert.equal(await pending, undefined);
});

test("collects unresolved comments across the whole review without leaking other revisions", async () => {
  activate({ textDiffs: [textDiff("edit.ts")] });
  const review = (await getActiveChangesReview())!;
  const directory = await fs.mkdtemp(path.join(root, "store-"));
  const store = new CommentStore(context(directory));
  const first = await store.createCode({ uri: uri("edit.ts", parent).toString(), body: "Change the original line", intent: "change",
    anchor: await createCodeAnchor(uri("edit.ts", parent), undefined, review) });
  const second = await store.createCode({ uri: uri("new file\nwith spaces.ts", commit).toString(), body: "Why add this?", intent: "question",
    anchor: await createCodeAnchor(uri("new file\nwith spaces.ts", commit), undefined, review) });
  const third = await store.createCode({ uri: uri("delete.ts", parent).toString(), body: "Keep this file", intent: "change",
    anchor: await createCodeAnchor(uri("delete.ts", parent), undefined, review) });
  await store.setStatus([third.id], "resolved");
  await store.createCode({ uri: first.uri, body: "Different commit with the SAME original document", intent: "change",
    anchor: { ...first.review.anchor, modifiedRef: addedOnly } });
  await store.createCode({ uri: first.uri, body: "Different repository", intent: "change",
    anchor: { ...first.review.anchor, repositoryRoot: path.join(root, "elsewhere") } });
  assert.deepEqual(store.getUnresolvedByChangesReview(review).map((comment) => comment.id), [first.id, second.id]);
  const output = compileCodeReview(store.getUnresolvedByChangesReview(review));
  assert.match(output, /Change the original line/);
  assert.match(output, /Why add this\?/);
  assert.doesNotMatch(output, /Different|Keep this file/);
  await store.setStatus([first.id, second.id], "sent");
  assert.equal(store.getUnresolvedByChangesReview(review).length, 0);
  const reloaded = new CommentStore(context(directory));
  await reloaded.load();
  assert.equal(reloaded.getUnresolvedByChangesReview(review).length, 0);
});

test("comment UI allows every review file, rejects standalone editors, and preserves plans", async () => {
  activate({ textDiffs: [textDiff("edit.ts")] });
  const directory = await fs.mkdtemp(path.join(root, "controller-"));
  const ctx = context(directory);
  const store = new CommentStore(ctx);
  const plans = new PlanStore(ctx);
  const planUri = vscode.Uri.file(path.join(root, "plan.md"));
  plans.isPublishedPlan = (documentUri) => documentUri.toString() === planUri.toString();
  const controller = new PiCommentController(plans, store);
  await controller.restore();
  controller.registerCommands(ctx);
  const ui = host.__test.state.controllers.at(-1);
  const ranges = (documentUri: vscode.Uri) => ui.commentingRangeProvider.provideCommentingRanges({ uri: documentUri, lineCount: 5 });
  for (const documentUri of [uri("edit.ts", parent), uri("edit.ts", commit), uri("new file\nwith spaces.ts", commit), uri("delete.ts", parent)]) {
    assert.equal((await ranges(documentUri)).length, 1);
  }
  assert.equal((await ranges(uri("edit.ts", addedOnly))).length, 0);
  const thread = ui.createCommentThread(uri("edit.ts", commit), new vscode.Range(0, 0, 0, 0), []);
  await host.__test.state.commands.get("piReview.addComment")({ thread, text: "Fix this" });
  assert.equal(controller.getUnresolvedCodeComments((await getActiveChangesReview())!).length, 1);
  assert.equal(thread.disposed, false);
  const rangeRefreshes = ui.rangeRefreshes;
  activate(textDiff("edit.ts"), uri("edit.ts", commit));
  host.__test.fireEditorsChanged();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ui.rangeRefreshes > rangeRefreshes, "refresh cached gutter affordances on editor changes");
  assert.equal(thread.disposed, true, "code threads must not remain in standalone editors");
  assert.equal((await ranges(uri("edit.ts", commit))).length, 0);
  assert.equal((await ranges(uri("new file\nwith spaces.ts", commit))).length, 0);
  assert.equal((await ranges(planUri)).length, 1);
  const rejectedThread = ui.createCommentThread(uri("edit.ts", commit), undefined, []);
  await host.__test.state.commands.get("piReview.addComment")({ thread: rejectedThread, text: "Not a review" });
  assert.equal(rejectedThread.disposed, true);
  activate({ textDiffs: [textDiff("edit.ts")] });
  await getActiveChangesReview();
  host.__test.fireEditorsChanged();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.threads.filter((item: any) => !item.disposed).length, 1, "returning to the Changes view restores its saved comments");
  controller.dispose();
});

test("missing historical directories and a parent workspace do not misidentify the repository", async () => {
  host.workspace.workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(root)), name: "parent", index: 0 }];
  activate({ textDiffs: [] }, uri("new-dir/added.ts", addedOnly), `${deletedOnly.slice(0, 7)} - Deleted directory`);
  const review = (await getActiveChangesReview())!;
  assert.equal(review.repositoryRoot, root);
  assert.ok(findReviewFile(review, uri("new-dir/added.ts", addedOnly)));
  host.workspace.workspaceFolders = [workspace];
});
