import { writeFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

type SessionEntry = ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>[number];

function branchSnapshot(ctx: ExtensionCommandContext): SessionEntry[] {
  const branch = [...ctx.sessionManager.getBranch()];
  if (ctx.isIdle()) return branch;

  // An in-flight assistant turn may contain tool calls whose results have not
  // arrived yet. Fork at the latest user message instead of persisting a
  // protocol-invalid partial turn.
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type === "message" && entry.message.role === "user") {
      return branch.slice(0, index + 1);
    }
  }
  return branch;
}

function createFork(ctx: ExtensionCommandContext): string {
  const manager = SessionManager.create(ctx.cwd);
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error("Could not create a session for the BTW pane.");

  const source = ctx.sessionManager.getSessionFile();
  const forkHeader = source ? { ...header, parentSession: source } : header;
  const entries = branchSnapshot(ctx);
  writeFileSync(
    file,
    [forkHeader, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    { flag: "wx" },
  );
  return file;
}

async function openBtwPane(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sessionFile: string,
): Promise<void> {
  const zellijSession = process.env.ZELLIJ_SESSION_NAME?.trim();
  if (!zellijSession) throw new Error("/btw requires Pi to be running inside Zellij.");

  const project = basename(ctx.cwd) || ctx.cwd;
  const piArgs = ["--session", sessionFile];
  if (ctx.model) {
    piArgs.push("--provider", ctx.model.provider, "--model", ctx.model.id);
  }
  if (ctx.thinkingLevel) piArgs.push("--thinking", ctx.thinkingLevel);

  const result = await pi.exec(
    "zellij",
    [
      "--session",
      zellijSession,
      "action",
      "new-pane",
      "--floating",
      "--near-current-pane",
      "--cwd",
      ctx.cwd,
      "--name",
      `btw · ${project}`,
      "--width",
      "84%",
      "--height",
      "84%",
      "--x",
      "8%",
      "--y",
      "8%",
      "--",
      "pi",
      ...piArgs,
    ],
    { timeout: 10_000 },
  );

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not open the BTW pane.");
  }

  const paneId = result.stdout.match(/(?:terminal|plugin)_\d+/)?.[0];
  if (paneId) {
    // Best effort: pane creation succeeded even if this older Zellij version
    // cannot focus it programmatically.
    await pi.exec(
      "zellij",
      ["--session", zellijSession, "action", "focus-pane-id", paneId],
      { timeout: 2_000 },
    );
  }
}

export default function btwExtension(pi: ExtensionAPI): void {
  pi.registerCommand("btw", {
    description: "Fork this conversation into a floating Zellij pane",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw requires Pi's interactive TUI.", "error");
        return;
      }
      if (!process.env.ZELLIJ_SESSION_NAME?.trim()) {
        ctx.ui.notify("/btw requires Pi to be running inside Zellij.", "error");
        return;
      }

      const sessionFile = createFork(ctx);
      try {
        await openBtwPane(pi, ctx, sessionFile);
        ctx.ui.notify("Forked this conversation into a BTW pane.", "info");
      } catch (error) {
        try {
          unlinkSync(sessionFile);
        } catch {}
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
