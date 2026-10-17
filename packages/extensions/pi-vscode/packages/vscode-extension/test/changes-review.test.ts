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
import { registerSendComments } from "../src/send-comments";

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

test("collects all comments across the whole review without leaking other revisions", async () => {
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
  await store.createCode({ uri: first.uri, body: "Different commit with the SAME original document", intent: "change",
    anchor: { ...first.review.anchor, modifiedRef: addedOnly } });
  await store.createCode({ uri: first.uri, body: "Different repository", intent: "change",
    anchor: { ...first.review.anchor, repositoryRoot: path.join(root, "elsewhere") } });
  const expected = [first.id, second.id, third.id];
  assert.deepEqual(store.getByChangesReview(review).map((comment) => comment.id), expected);
  const output = compileCodeReview(store.getByChangesReview(review));
  assert.match(output, /Change the original line/);
  assert.match(output, /Why add this\?/);
  assert.match(output, /Keep this file/);
  assert.doesNotMatch(output, /Different/);
  const reloaded = new CommentStore(context(directory));
  await reloaded.load();
  assert.deepEqual(reloaded.getByChangesReview(review).map((comment) => comment.id), expected);
  assert.equal(compileCodeReview(reloaded.getByChangesReview(review)), output);
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
  assert.equal(controller.getCodeComments((await getActiveChangesReview())!).length, 1);
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

test("focusing a draft comment or another file does not rebuild the comment input", async () => {
  for (const addedOnlyView of [false, true]) {
    const documentUri = addedOnlyView ? uri("new-dir/added.ts", addedOnly) : uri("edit.ts", commit);
    const tab = activate({ textDiffs: addedOnlyView ? [] : [textDiff("edit.ts")] }, documentUri,
      addedOnlyView ? `${addedOnly.slice(0, 7)} - Add only` : "Changes");
    const directory = await fs.mkdtemp(path.join(root, "focus-"));
    const ctx = context(directory);
    const controller = new PiCommentController(new PlanStore(ctx), new CommentStore(ctx));
    await controller.restore();
    controller.registerCommands(ctx);
    const ui = host.__test.state.controllers.at(-1);
    const draft = ui.createCommentThread(documentUri, new vscode.Range(0, 0, 0, 0), []);
    const refreshes = ui.rangeRefreshes;

    // Entering VS Code's embedded comment editor clears the active text editor.
    host.window.activeTextEditor = undefined;
    host.__test.fireEditorsChanged();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.rangeRefreshes, refreshes, "focusing the input must not trigger widget reconstruction");

    host.window.activeTextEditor = { document: { uri: documentUri } };
    host.__test.fireEditorsChanged();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.rangeRefreshes, refreshes, "returning to a file must not rebuild its draft");

    if (!addedOnlyView) {
      host.window.activeTextEditor = { document: { uri: uri("new file\nwith spaces.ts", commit) } };
      // The tab API can replace its input object without changing the revisions.
      tab.input = { textDiffs: [textDiff("edit.ts")] };
      await getActiveChangesReview();
      host.__test.fireEditorsChanged();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(ui.rangeRefreshes, refreshes, "same-review file/input changes must preserve drafts");
    }
    await host.__test.state.commands.get("piReview.addComment")({ thread: draft, text: "Draft survives focus" });
    assert.equal(draft.disposed, false);
    assert.equal(controller.getCodeComments((await getActiveChangesReview())!).length, 1);
    controller.dispose();
  }
});

test("missing historical directories and a parent workspace do not misidentify the repository", async () => {
  host.workspace.workspaceFolders = [{ uri: vscode.Uri.file(path.dirname(root)), name: "parent", index: 0 }];
  activate({ textDiffs: [] }, uri("new-dir/added.ts", addedOnly), `${deletedOnly.slice(0, 7)} - Deleted directory`);
  const review = (await getActiveChangesReview())!;
  assert.equal(review.repositoryRoot, root);
  assert.ok(findReviewFile(review, uri("new-dir/added.ts", addedOnly)));
  host.workspace.workspaceFolders = [workspace];
});

test("the manifest has one unconditional send button and defaults the Comments panel to stay closed", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, "../package.json"), "utf8"));
  assert.deepEqual(manifest.contributes.menus["editor/title"], [{ command: "piReview.sendComments", group: "navigation" }]);
  assert.equal(manifest.contributes.configurationDefaults["comments.openView"], "never");
  assert.equal(manifest.contributes.commands.find((command: any) => command.command === "piReview.sendComments").enablement, undefined);
  for (const removed of ["piReview.sendCodeReview", "piReview.sendPlanReview", "piReview.sendTestPrefill", "piReview.resolveComment", "piReview.reopenComment"]) {
    assert.ok(!manifest.contributes.commands.some((command: any) => command.command === removed));
  }
});

test("the send command resends all current-window comments without mutating feedback or rebuilding inputs", async () => {
  activate({ textDiffs: [textDiff("edit.ts")] });
  const review = (await getActiveChangesReview())!;
  const directory = await fs.mkdtemp(path.join(root, "send-"));
  const ctx = context(directory);
  const store = new CommentStore(ctx);
  const plans = new PlanStore(ctx);
  const controller = new PiCommentController(plans, store);
  await controller.restore();
  const payloads: string[] = [];
  let accepted = true;
  const sender = { connectedPi: true, async sendPrefill(text: string) {
    payloads.push(text);
    return { type: "prefillResult" as const, ok: accepted, message: accepted ? undefined : "Try again" };
  } };
  const registration = registerSendComments(sender, plans, controller);
  const send = host.__test.state.commands.get("piReview.sendComments");
  await send();
  assert.equal(payloads.length, 0, "an empty view should not send anything");
  assert.match(host.__test.state.errors.at(-1), /no comments/i);
  const first = await store.createCode({ uri: uri("edit.ts", commit).toString(), body: "Edit feedback", intent: "change",
    anchor: await createCodeAnchor(uri("edit.ts", commit), undefined, review) });
  await store.createCode({ uri: uri("delete.ts", parent).toString(), body: "Deletion feedback", intent: "question",
    anchor: await createCodeAnchor(uri("delete.ts", parent), undefined, review) });
  await store.createCode({ uri: first.uri, body: "Not this commit", intent: "change", anchor: { ...first.review.anchor, modifiedRef: addedOnly } });
  const before = await fs.readFile(path.join(directory, "comments.json"), "utf8");
  const ui = host.__test.state.controllers.at(-1);
  const refreshes = ui.rangeRefreshes;
  host.window.activeTextEditor = undefined; // The comment editor, not the file, has focus.
  sender.connectedPi = false;
  await send();
  assert.equal(payloads.length, 0);
  sender.connectedPi = true;
  accepted = false;
  await send();
  assert.equal(host.__test.state.errors.at(-1), "Try again");
  accepted = true;
  await send();
  await send();
  assert.equal(payloads.length, 3);
  assert.equal(payloads[0], payloads[1]);
  assert.equal(payloads[1], payloads[2]);
  assert.match(payloads[2], /Edit feedback/);
  assert.match(payloads[2], /Deletion feedback/);
  assert.doesNotMatch(payloads[2], /Not this commit/);
  assert.equal(await fs.readFile(path.join(directory, "comments.json"), "utf8"), before);
  assert.equal(ui.rangeRefreshes, refreshes, "sending must not rebuild comment inputs");
  await store.delete(first.id);
  await send();
  assert.doesNotMatch(payloads[3], /Edit feedback/);
  assert.match(payloads[3], /Deletion feedback/);
  activate(textDiff("edit.ts"));
  await send();
  assert.equal(payloads.length, 4, "a visible button must not send a different view's comments");
  registration.dispose();
  controller.dispose();
});

test("legacy sent and resolved comments are retained without lifecycle tracking", async () => {
  activate({ textDiffs: [textDiff("edit.ts")] });
  const review = (await getActiveChangesReview())!;
  const directory = await fs.mkdtemp(path.join(root, "legacy-"));
  const ctx = context(directory);
  const store = new CommentStore(ctx);
  const anchor = await createCodeAnchor(uri("edit.ts", commit), undefined, review);
  for (const body of ["Previously sent", "Previously resolved", "Previously new"]) {
    await store.createCode({ uri: anchor.documentUri, body, intent: "change", anchor });
  }
  const filePath = path.join(directory, "comments.json");
  const legacy = JSON.parse(await fs.readFile(filePath, "utf8"));
  for (const [index, comment] of legacy.comments.entries()) comment.review.status = ["sent", "resolved", "unresolved"][index];
  await fs.writeFile(filePath, JSON.stringify(legacy));
  const restored = new CommentStore(ctx);
  await restored.load();
  const feedback = restored.getByChangesReview(review);
  assert.equal(feedback.length, 3);
  assert.ok(feedback.every((comment) => !("status" in comment.review)));
  await restored.updateBody(feedback[0].id, "Updated feedback");
  const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
  assert.ok(saved.comments.every((comment: any) => !("status" in comment.review)));
});

test("the same permanent send button uses the active plan tab even with comment-input focus", async () => {
  const directory = await fs.mkdtemp(path.join(root, "plan-send-"));
  const ctx = context(directory);
  const store = new CommentStore(ctx);
  const plans = new PlanStore(ctx);
  const planUri = vscode.Uri.file(path.join(root, "plan.md"));
  const metadata = { planId: "test-plan", version: 1, title: "Plan", documentHash: "hash", createdAt: new Date().toISOString() };
  plans.getMetadata = (documentUri) => documentUri.toString() === planUri.toString() ? metadata : undefined;
  const controller = new PiCommentController(plans, store);
  activate(new vscode.TabInputText(planUri));
  await controller.restore();
  const anchor = { kind: "plan" as const, planId: metadata.planId, planVersion: 1, documentHash: "hash",
    range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 4 }, selectedText: "Plan", linesBefore: [], linesAfter: [] };
  await store.createPlan({ uri: planUri.toString(), body: "Revise the plan", intent: "change", anchor });
  await store.createPlan({ uri: planUri.toString(), body: "Explain the plan", intent: "question", anchor });
  await store.createPlan({ uri: planUri.toString(), body: "Different version", intent: "change", anchor: { ...anchor, planVersion: 2 } });
  const payloads: string[] = [];
  const registration = registerSendComments({ connectedPi: true, async sendPrefill(text) {
    payloads.push(text); return { type: "prefillResult", ok: true };
  } }, plans, controller);
  const send = host.__test.state.commands.get("piReview.sendComments");
  await send();
  await send();
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0], payloads[1]);
  assert.match(payloads[0], /Revise the plan/);
  assert.match(payloads[0], /Explain the plan/);
  assert.doesNotMatch(payloads[0], /Different version/);
  registration.dispose();
  controller.dispose();
});
