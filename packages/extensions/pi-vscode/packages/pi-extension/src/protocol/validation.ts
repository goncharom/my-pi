import { Type } from "typebox";
import { Value } from "typebox/value";
import { PROTOCOL_VERSION, type PiToVSCode, type VSCodeToPi } from "./messages";

const errorCodeSchema = Type.Union([
  Type.Literal("INVALID_TOKEN"),
  Type.Literal("ALREADY_CONNECTED"),
  Type.Literal("NOT_CONNECTED"),
  Type.Literal("INVALID_MESSAGE"),
  Type.Literal("INTERNAL_ERROR"),
]);

export const connectMessageSchema = Type.Object({
  type: Type.Literal("connect"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  token: Type.String({ minLength: 1 }),
  cwd: Type.String({ minLength: 1 }),
  repoRoot: Type.Optional(Type.String({ minLength: 1 })),
  sessionName: Type.Optional(Type.String({ minLength: 1 })),
  pid: Type.Integer({ minimum: 1 }),
});

export const disconnectMessageSchema = Type.Object({
  type: Type.Literal("disconnect"),
});

export const publishPlanMessageSchema = Type.Object({
  type: Type.Literal("publishPlan"),
  title: Type.String({ minLength: 1 }),
  markdown: Type.String(),
  planId: Type.Optional(Type.String({ minLength: 1 })),
});

export const prefillResultMessageSchema = Type.Object({
  type: Type.Literal("prefillResult"),
  ok: Type.Boolean(),
  queued: Type.Optional(Type.Boolean()),
  message: Type.Optional(Type.String()),
});

export const connectedMessageSchema = Type.Object({
  type: Type.Literal("connected"),
  instanceId: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
});

export const planPublishedMessageSchema = Type.Object({
  type: Type.Literal("planPublished"),
  planId: Type.String({ minLength: 1 }),
  version: Type.Integer({ minimum: 1 }),
  uri: Type.String({ minLength: 1 }),
});

export const prefillMessageSchema = Type.Object({
  type: Type.Literal("prefill"),
  text: Type.String(),
});

export const errorMessageSchema = Type.Object({
  type: Type.Literal("error"),
  code: errorCodeSchema,
  message: Type.String(),
});

export const piToVSCodeSchema = Type.Union([
  connectMessageSchema,
  disconnectMessageSchema,
  publishPlanMessageSchema,
  prefillResultMessageSchema,
]);

export const vsCodeToPiSchema = Type.Union([
  connectedMessageSchema,
  planPublishedMessageSchema,
  prefillMessageSchema,
  errorMessageSchema,
]);

export function parsePiToVSCodeMessage(input: unknown): PiToVSCode {
  return Value.Parse(piToVSCodeSchema, Value.Clean(piToVSCodeSchema, input)) as PiToVSCode;
}

export function parseVSCodeToPiMessage(input: unknown): VSCodeToPi {
  return Value.Parse(vsCodeToPiSchema, Value.Clean(vsCodeToPiSchema, input)) as VSCodeToPi;
}
