import type * as vscode from "vscode";

export interface GitUriInfo {
  filePath: string;
  ref: string;
}

/** Decode the built-in Git extension's revision URI without guessing a repository root. */
export function parseGitUri(uri: vscode.Uri): GitUriInfo | undefined {
  if (uri.scheme !== "git") return undefined;
  let query: unknown;
  try {
    query = JSON.parse(uri.query);
  } catch {
    try {
      query = JSON.parse(decodeURIComponent(uri.query));
    } catch {
      return undefined;
    }
  }
  if (!query || typeof query !== "object" || !("path" in query) || !("ref" in query)) return undefined;
  if (typeof query.path !== "string" || !query.path || typeof query.ref !== "string") return undefined;
  return { filePath: query.path, ref: query.ref };
}
