export interface WorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  prunable?: string;
  dirty: boolean;
  current: boolean;
}

export type SessionKind = "new" | "fork";
export type LaunchLocation = "here" | "pane" | "tab";

export interface LaunchChoice {
  sessionKind: SessionKind;
  location: LaunchLocation;
}

export type WorktreeAction =
  | { type: "open"; worktree: WorktreeInfo }
  | { type: "create" }
  | { type: "delete"; worktree: WorktreeInfo }
  | { type: "cancel" };
