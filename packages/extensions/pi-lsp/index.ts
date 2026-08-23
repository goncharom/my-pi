import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { LspManager } from "./src/manager";
import { registerLspTools } from "./src/tools";
import type { LspManagerStatus } from "./src/types";

export default function lspExtension(pi: ExtensionAPI): void {
  let manager: LspManager | undefined;

  registerLspTools(pi, () => {
    if (!manager) throw new Error("The LSP session is not initialized.");
    return manager;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (manager) await manager.shutdown();
    manager = new LspManager(ctx.cwd, (status) => updateStatus(ctx, status));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const current = manager;
    manager = undefined;
    await current?.shutdown();
    if (ctx.hasUI) ctx.ui.setStatus("pi-lsp", undefined);
  });
}

function updateStatus(ctx: ExtensionContext, status: LspManagerStatus): void {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;
  const text = status.state === "idle"
    ? theme.fg("dim", "LSP idle")
    : status.state === "starting"
      ? theme.fg("warning", `LSP starting · ${status.language}`)
      : status.state === "ready"
        ? theme.fg("success", `LSP ready · ${status.count}`)
        : theme.fg("error", `LSP error · ${status.language}`);
  ctx.ui.setStatus("pi-lsp", text);
}
