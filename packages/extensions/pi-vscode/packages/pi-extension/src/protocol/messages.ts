export const PROTOCOL_VERSION = 1 as const;

export type ErrorCode =
  | "INVALID_TOKEN"
  | "ALREADY_CONNECTED"
  | "NOT_CONNECTED"
  | "INVALID_MESSAGE"
  | "INTERNAL_ERROR";

export interface ConnectMessage {
  type: "connect";
  protocolVersion: 1;
  token: string;
  cwd: string;
  repoRoot?: string;
  sessionName?: string;
  pid: number;
}

export interface ConnectedMessage {
  type: "connected";
  instanceId: string;
  displayName: string;
}

export interface DisconnectMessage {
  type: "disconnect";
}

export interface PublishPlanMessage {
  type: "publishPlan";
  title: string;
  markdown: string;
  planId?: string;
}

export interface PlanPublishedMessage {
  type: "planPublished";
  planId: string;
  version: number;
  uri: string;
}

export interface PrefillMessage {
  type: "prefill";
  text: string;
}

export interface PrefillResultMessage {
  type: "prefillResult";
  ok: boolean;
  queued?: boolean;
  message?: string;
}

export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message: string;
}

export type PiToVSCode = ConnectMessage | DisconnectMessage | PublishPlanMessage | PrefillResultMessage;

export type VSCodeToPi = ConnectedMessage | PlanPublishedMessage | PrefillMessage | ErrorMessage;

export type ProtocolMessage = PiToVSCode | VSCodeToPi;
