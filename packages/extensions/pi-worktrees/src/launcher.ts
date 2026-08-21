import { existsSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { LaunchChoice, LaunchLocation, SessionKind } from "./types";
import { LaunchPickerComponent } from "./ui";

function currentSessionCanFork(ctx: ExtensionCommandContext): boolean {
  return Boolean(ctx.sessionManager.getSessionFile());
}

async function zellijAvailable(pi: ExtensionAPI): Promise<boolean> {
  if (!process.env.ZELLIJ_SESSION_NAME?.trim()) return false;
  const result = await pi.exec("zellij", ["--version"], { timeout: 2_000 });
  return result.code === 0;
}

async function chooseLaunch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  targetPath: string,
): Promise<LaunchChoice | null> {
  const canFork = currentSessionCanFork(ctx);
  const hasZellij = await zellijAvailable(pi);
  return ctx.ui.custom<LaunchChoice | null>(
    (tui, theme, _keybindings, done) =>
      new LaunchPickerComponent(
        targetPath,
        canFork,
        hasZellij,
        theme,
        () => tui.requestRender(),
        done,
      ),
    {
      overlay: true,
      overlayOptions: {
        width: "62%",
        minWidth: 52,
        maxHeight: "58%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

function writeCreatedSession(
  manager: SessionManager,
  entries: unknown[] = [],
  headerOverride?: Record<string, unknown>,
): string {
  const file = manager.getSessionFile();
  const header = headerOverride ?? manager.getHeader();
  if (!file || !header) throw new Error("Could not create a persistent Pi session for the destination.");
  writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
    flag: "wx",
  });
  return file;
}

function createSession(
  ctx: ExtensionCommandContext,
  targetPath: string,
  sessionKind: SessionKind,
): string {
  if (sessionKind === "fork") {
    const source = ctx.sessionManager.getSessionFile();
    if (!source) throw new Error("The current session is ephemeral and cannot be forked.");
    if (existsSync(source)) {
      const manager = SessionManager.forkFrom(source, targetPath);
      const file = manager.getSessionFile();
      if (!file) throw new Error("Could not create a persistent Pi session for the destination.");
      return file;
    }

    // Pi intentionally keeps sessions without an assistant response in memory.
    // Materialize that in-memory tree directly into the target worktree.
    const manager = SessionManager.create(targetPath);
    const header = manager.getHeader();
    if (!header) throw new Error("Could not create the forked session header.");
    return writeCreatedSession(
      manager,
      ctx.sessionManager.getEntries(),
      { ...header, parentSession: source },
    );
  }

  const manager = SessionManager.create(targetPath);
  return writeCreatedSession(manager);
}

async function openInZellij(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  targetPath: string,
  sessionFile: string,
  location: Exclude<LaunchLocation, "here">,
): Promise<void> {
  const sessionName = process.env.ZELLIJ_SESSION_NAME?.trim();
  if (!sessionName) throw new Error("Pi is not currently running inside Zellij.");

  const label = `pi · ${basename(targetPath) || targetPath}`;
  const piArgs = ["--session", sessionFile];
  if (ctx.model) {
    piArgs.push("--provider", ctx.model.provider, "--model", ctx.model.id);
  }
  if (ctx.thinkingLevel) piArgs.push("--thinking", ctx.thinkingLevel);

  const action = location === "pane" ? "new-pane" : "new-tab";
  const args = ["--session", sessionName, "action", action, "--cwd", targetPath, "--name", label, "--", "pi", ...piArgs];
  const result = await pi.exec("zellij", args, { timeout: 10_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Could not create a Zellij ${location}.`);
  }
  ctx.ui.notify(`Opened ${label} in a new Zellij ${location}.`, "info");
}

export async function launchWorkspace(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  targetPath: string,
): Promise<boolean> {
  const choice = await chooseLaunch(pi, ctx, targetPath);
  if (!choice) return false;

  const sessionFile = createSession(ctx, targetPath, choice.sessionKind);
  if (choice.location === "here") {
    const label = basename(targetPath) || targetPath;
    await ctx.switchSession(sessionFile, {
      withSession: async (next) => {
        next.ui.notify(
          `${choice.sessionKind === "fork" ? "Forked into" : "Opened"} ${label}`,
          "info",
        );
      },
    });
    return true;
  }

  await openInZellij(pi, ctx, targetPath, sessionFile, choice.location);
  return true;
}
