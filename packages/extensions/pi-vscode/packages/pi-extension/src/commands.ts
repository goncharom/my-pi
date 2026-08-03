import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { filterReachableEntries, findWorkspaceMatches, readRegistryEntries, type VSCodeRegistryEntry } from "./registry";
import { setPrefillContext } from "./review-prefill";
import type { VSCodeSocketClient } from "./socket-client";

export function registerCommands(pi: ExtensionAPI, client: VSCodeSocketClient): void {
  pi.registerCommand("vscode-connect", {
    description: "Connect this Pi session to the matching Remote-SSH VS Code window.",
    handler: async (_args, ctx) => {
      setPrefillContext(ctx);

      if (client.isConnected) {
        ctx.ui.notify(`Already connected to VS Code: ${client.info?.displayName ?? "unknown window"}`, "info");
        return;
      }

      const cwd = ctx.cwd;
      const repoRoot = await getGitRoot(pi, cwd);
      const entries = await filterReachableEntries(await readRegistryEntries());
      const matches = findWorkspaceMatches(entries, cwd, repoRoot);

      if (matches.length === 0) {
        ctx.ui.notify("No matching Remote-SSH VS Code window was found for this repository.", "error");
        return;
      }

      const selected = await selectEntry(ctx, matches);
      if (!selected) return;

      try {
        const info = await client.connect(selected, {
          cwd,
          repoRoot,
          sessionName: pi.getSessionName(),
          pid: process.pid,
        });
        ctx.ui.notify(`Connected to VS Code: ${info.displayName}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Another Pi session")) {
          ctx.ui.notify("Another Pi session is already connected.\nDisconnect it before connecting this session.", "error");
          return;
        }
        ctx.ui.notify(`Failed to connect to VS Code: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("vscode-disconnect", {
    description: "Disconnect this Pi session from VS Code.",
    handler: async (_args, ctx) => {
      setPrefillContext(ctx);
      if (!client.isConnected) {
        ctx.ui.notify("VS Code is not connected.", "info");
        return;
      }

      client.disconnect();
      ctx.ui.notify("VS Code disconnected.", "info");
    },
  });

  pi.registerCommand("vscode-status", {
    description: "Show the VS Code bridge connection status.",
    handler: async (_args, ctx) => {
      setPrefillContext(ctx);
      const info = client.info;
      if (!info) {
        ctx.ui.notify("VS Code: disconnected", "info");
        return;
      }

      ctx.ui.notify(["VS Code: connected", `Window: ${info.displayName}`, `Socket: ${info.socketPath}`].join("\n"), "info");
    },
  });
}

async function getGitRoot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 2_000 });
    if (result.code === 0) {
      const root = result.stdout.trim();
      return root.length > 0 ? root : undefined;
    }
  } catch {
    // Git is optional.
  }
  return undefined;
}

async function selectEntry(
  ctx: ExtensionCommandContext,
  entries: VSCodeRegistryEntry[],
): Promise<VSCodeRegistryEntry | undefined> {
  if (entries.length === 1) return entries[0];

  const labels = entries.map((entry, index) => `${index + 1}. ${entry.displayName} (${entry.workspaceRoots.join(", ")})`);
  const selected = await ctx.ui.select("Select VS Code window:", labels);
  if (!selected) return undefined;
  const index = labels.indexOf(selected);
  return index >= 0 ? entries[index] : undefined;
}
