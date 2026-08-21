import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createWorktree,
  getRepoRoot,
  listWorktrees,
  removeWorktree,
  suggestedWorktreePath,
} from "./src/git";
import { launchWorkspace } from "./src/launcher";
import type { WorktreeAction } from "./src/types";
import { WorktreeListComponent } from "./src/ui";

async function chooseWorktreeAction(
  ctx: ExtensionCommandContext,
  worktrees: Awaited<ReturnType<typeof listWorktrees>>,
): Promise<WorktreeAction> {
  return ctx.ui.custom<WorktreeAction>(
    (tui, theme, _keybindings, done) =>
      new WorktreeListComponent(worktrees, theme, () => tui.requestRender(), done),
    {
      overlay: true,
      overlayOptions: {
        width: "80%",
        minWidth: 60,
        maxHeight: "82%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

async function createFromCurrentHead(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repoRoot: string,
  namingRoot: string,
): Promise<string | null> {
  const branch = await ctx.ui.input("New worktree branch", "feature/my-change");
  if (branch === undefined) return null;
  if (!branch.trim()) {
    ctx.ui.notify("Branch name cannot be empty.", "error");
    return null;
  }

  const suggestion = suggestedWorktreePath(namingRoot, branch);
  const pathInput = await ctx.ui.input("Worktree path (empty uses suggestion)", suggestion);
  if (pathInput === undefined) return null;
  const targetPath = resolve(repoRoot, pathInput.trim() || suggestion);
  const confirmed = await ctx.ui.confirm(
    "Create worktree?",
    `${branch.trim()}\n${targetPath}\n\nBase: current HEAD`,
  );
  if (!confirmed) return null;

  await createWorktree(pi, repoRoot, branch.trim(), targetPath);
  ctx.ui.notify(`Created ${branch.trim()} at ${targetPath}`, "info");
  return targetPath;
}

async function runWorktrees(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/worktrees requires Pi's interactive TUI.", "error");
    return;
  }

  let repoRoot: string;
  try {
    repoRoot = await getRepoRoot(pi, ctx.cwd);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }

  while (true) {
    let worktrees: Awaited<ReturnType<typeof listWorktrees>>;
    try {
      worktrees = await listWorktrees(pi, repoRoot, repoRoot);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }

    const action = await chooseWorktreeAction(ctx, worktrees);
    if (action.type === "cancel") return;

    if (action.type === "open") {
      if (action.worktree.bare) {
        ctx.ui.notify("A bare repository cannot be opened as a worktree.", "error");
        continue;
      }
      if (action.worktree.prunable) {
        ctx.ui.notify(`This worktree is ${action.worktree.prunable}.`, "error");
        continue;
      }
      try {
        if (await launchWorkspace(pi, ctx, action.worktree.path)) return;
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
      continue;
    }

    if (action.type === "create") {
      try {
        const targetPath = await createFromCurrentHead(
          pi,
          ctx,
          repoRoot,
          worktrees[0]?.path ?? repoRoot,
        );
        if (targetPath && await launchWorkspace(pi, ctx, targetPath)) return;
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
      continue;
    }

    if (action.worktree.current) {
      ctx.ui.notify("Cannot remove the worktree used by this Pi session.", "error");
      continue;
    }
    if (action.worktree.dirty) {
      ctx.ui.notify("Refusing to remove a dirty worktree.", "error");
      continue;
    }
    const confirmed = await ctx.ui.confirm(
      "Remove worktree?",
      `${action.worktree.branch ?? action.worktree.path}\n${action.worktree.path}`,
    );
    if (!confirmed) continue;
    try {
      await removeWorktree(pi, repoRoot, action.worktree.path);
      ctx.ui.notify(`Removed ${action.worktree.path}`, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}

export default function worktreesExtension(pi: ExtensionAPI): void {
  pi.registerCommand("worktrees", {
    description: "Manage Git worktrees and open a fresh or forked Pi session",
    handler: async (_args, ctx) => runWorktrees(pi, ctx),
  });
}
