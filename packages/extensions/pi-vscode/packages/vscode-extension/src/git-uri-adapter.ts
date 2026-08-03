import * as path from "node:path";
import * as vscode from "vscode";

export interface GitUriInfo {
  repositoryRoot?: string;
  relativePath?: string;
  ref?: string;
}

export function parseGitUri(uri: vscode.Uri): GitUriInfo | undefined {
  if (uri.scheme !== "git") return undefined;

  const query = parseGitQuery(uri.query);
  const queryPath = typeof query?.path === "string" ? query.path : undefined;
  const ref = typeof query?.ref === "string" ? query.ref : undefined;
  const fsPath = queryPath ?? uri.path;
  const workspace = workspaceFolderForFsPath(fsPath);

  return {
    repositoryRoot: workspace?.uri.fsPath,
    relativePath: workspace ? path.relative(workspace.uri.fsPath, fsPath) : path.basename(fsPath),
    ref,
  };
}

function parseGitQuery(query: string): Record<string, unknown> | undefined {
  if (!query) return undefined;
  try {
    return JSON.parse(query) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(decodeURIComponent(query)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

function workspaceFolderForFsPath(fsPath: string): vscode.WorkspaceFolder | undefined {
  let best: vscode.WorkspaceFolder | undefined;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const relative = path.relative(folder.uri.fsPath, fsPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      if (!best || folder.uri.fsPath.length > best.uri.fsPath.length) best = folder;
    }
  }
  return best;
}
