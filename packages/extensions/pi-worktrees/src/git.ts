import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorktreeInfo } from "./types";

function failure(stderr: string, stdout: string, fallback: string): Error {
  return new Error(stderr.trim() || stdout.trim() || fallback);
}

function comparablePath(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return absolute;
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: 5_000,
  });
  if (result.code !== 0) {
    throw failure(result.stderr, result.stdout, "The current directory is not inside a Git repository.");
  }
  return resolve(result.stdout.trim());
}

export async function listWorktrees(
  pi: ExtensionAPI,
  repoRoot: string,
  currentRoot: string,
): Promise<WorktreeInfo[]> {
  const result = await pi.exec("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    timeout: 10_000,
  });
  if (result.code !== 0) {
    throw failure(result.stderr, result.stdout, "Could not list Git worktrees.");
  }

  const records = result.stdout.trim().split(/\n\s*\n/).filter(Boolean);
  const worktrees = records.map(parseWorktreeRecord);
  const current = comparablePath(currentRoot);

  await Promise.all(
    worktrees.map(async (worktree) => {
      worktree.current = comparablePath(worktree.path) === current;
      if (worktree.bare || !existsSync(worktree.path)) return;
      const status = await pi.exec("git", ["status", "--porcelain"], {
        cwd: worktree.path,
        timeout: 5_000,
      });
      worktree.dirty = status.code !== 0 || status.stdout.trim().length > 0;
    }),
  );

  return worktrees;
}

function parseWorktreeRecord(record: string): WorktreeInfo {
  const worktree: WorktreeInfo = {
    path: "",
    detached: false,
    bare: false,
    dirty: false,
    current: false,
  };

  for (const line of record.split("\n")) {
    const separator = line.indexOf(" ");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);
    switch (key) {
      case "worktree": worktree.path = resolve(value); break;
      case "HEAD": worktree.head = value; break;
      case "branch": worktree.branch = value.replace(/^refs\/heads\//, ""); break;
      case "detached": worktree.detached = true; break;
      case "bare": worktree.bare = true; break;
      case "prunable": worktree.prunable = value || "prunable"; break;
    }
  }

  return worktree;
}

export function suggestedWorktreePath(repoRoot: string, branch: string): string {
  const safeBranch = branch
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worktree";
  return join(dirname(repoRoot), `${basename(repoRoot)}-${safeBranch}`);
}

export async function createWorktree(
  pi: ExtensionAPI,
  repoRoot: string,
  branch: string,
  targetPath: string,
): Promise<void> {
  const branchCheck = await pi.exec("git", ["check-ref-format", "--branch", branch], {
    cwd: repoRoot,
    timeout: 5_000,
  });
  if (branchCheck.code !== 0) {
    throw failure(branchCheck.stderr, branchCheck.stdout, `Invalid branch name: ${branch}`);
  }

  const result = await pi.exec(
    "git",
    ["worktree", "add", "-b", branch, resolve(targetPath), "HEAD"],
    { cwd: repoRoot, timeout: 30_000 },
  );
  if (result.code !== 0) {
    throw failure(result.stderr, result.stdout, "Could not create the worktree.");
  }
}

export async function removeWorktree(
  pi: ExtensionAPI,
  repoRoot: string,
  targetPath: string,
): Promise<void> {
  const result = await pi.exec("git", ["worktree", "remove", resolve(targetPath)], {
    cwd: repoRoot,
    timeout: 30_000,
  });
  if (result.code !== 0) {
    throw failure(result.stderr, result.stdout, "Could not remove the worktree.");
  }
}
