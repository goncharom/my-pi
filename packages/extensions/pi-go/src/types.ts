export type SessionKind = "new" | "fork";
export type LaunchLocation = "here" | "pane" | "tab";

export interface LaunchChoice {
  sessionKind: SessionKind;
  location: LaunchLocation;
}
