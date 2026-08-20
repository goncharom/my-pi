import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { parseGitUri, type GitUriInfo } from "./git-uri-adapter";

const execFileAsync = promisify(execFile);

/** Returns true when a Git revision editor shows a file added by that commit. */
export async function isAddedGitRevisionDocument(uri: vscode.Uri): Promise<boolean> {
  const gitInfo = parseGitUri(uri);
  if (!gitInfo?.ref) return false;
  return isFileAddedAtRevision(gitInfo);
}

async function isFileAddedAtRevision(gitInfo: GitUriInfo): Promise<boolean> {
  try {
    const { stdout: rootOutput } = await execFileAsync("git", ["-C", path.dirname(gitInfo.filePath), "rev-parse", "--show-toplevel"], { timeout: 2_000 });
    const repositoryRoot = rootOutput.trim();
    const relativePath = path.relative(repositoryRoot, gitInfo.filePath);
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryRoot, "diff-tree", "--root", "--no-commit-id", "--name-only", "--diff-filter=A", "-r", gitInfo.ref!, "--", relativePath],
      { timeout: 2_000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
