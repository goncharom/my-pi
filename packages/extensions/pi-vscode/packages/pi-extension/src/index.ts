import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands";
import { linkifyFileReferences } from "./file-links";
import { registerPublishPlanTool } from "./publish-plan";
import { flushPendingPrefill, handlePrefill, notifyFromVSCode, setPrefillContext } from "./review-prefill";
import { VSCodeSocketClient } from "./socket-client";

export default function (pi: ExtensionAPI): void {
  const client = new VSCodeSocketClient(
    handlePrefill,
    () => notifyFromVSCode("VS Code disconnected. Run /vscode-connect to reconnect.", "warning"),
    (message) => notifyFromVSCode(`VS Code error: ${message}`, "error"),
  );

  registerCommands(pi, client);
  registerPublishPlanTool(pi, client);

  pi.on("session_start", async (_event, ctx) => {
    setPrefillContext(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    let changed = false;
    const content = event.message.content.map((part) => {
      if (part.type !== "text") return part;
      const text = linkifyFileReferences(part.text, ctx.cwd, client.isConnected);
      changed ||= text !== part.text;
      return text === part.text ? part : { ...part, text };
    });

    return changed ? { message: { ...event.message, content } } : undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    flushPendingPrefill(ctx);
  });

  pi.on("session_shutdown", async () => {
    client.dispose(true);
  });
}
