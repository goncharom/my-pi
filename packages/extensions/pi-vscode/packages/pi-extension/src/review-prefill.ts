import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PrefillHandlerResult } from "./socket-client";

let currentContext: ExtensionContext | undefined;
let pendingText: string | undefined;

export function setPrefillContext(ctx: ExtensionContext): void {
  currentContext = ctx;
}

export async function handlePrefill(text: string): Promise<PrefillHandlerResult> {
  const ctx = currentContext;

  if (ctx?.isIdle()) {
    insertReview(ctx, text);
    ctx.ui.notify("VS Code review added to input.", "info");
    return { ok: true, queued: false };
  }

  if (pendingText !== undefined) {
    return { ok: false, message: "A review is already waiting to be inserted." };
  }

  pendingText = text;
  return { ok: true, queued: true };
}

export function flushPendingPrefill(ctx: ExtensionContext): void {
  setPrefillContext(ctx);
  if (pendingText === undefined || !ctx.isIdle()) return;

  const text = pendingText;
  pendingText = undefined;
  insertReview(ctx, text);
  ctx.ui.notify("VS Code review added to input.", "info");
}

export function notifyFromVSCode(message: string, level: "info" | "warning" | "error" = "info"): void {
  currentContext?.ui.notify(message, level);
}

export function insertReview(ctx: ExtensionContext, text: string): void {
  const existing = ctx.ui.getEditorText();

  if (existing.trim() === "") {
    ctx.ui.setEditorText(text);
    return;
  }

  ctx.ui.setEditorText(`${existing.trimEnd()}\n\n${text}`);
}
