import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { launchWorkspace } from "./src/launcher";
import { DirectoryNavigatorComponent } from "./src/ui";

function normalizeCommandPath(cwd: string, args: string): string {
  let value = args.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  if (value.startsWith("@")) value = value.slice(1);
  return resolve(cwd, value || ".");
}

async function chooseDirectory(
  ctx: ExtensionCommandContext,
  initialPath: string,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (tui, theme, _keybindings, done) =>
      new DirectoryNavigatorComponent(initialPath, theme, () => tui.requestRender(), done),
    {
      overlay: true,
      overlayOptions: {
        width: "72%",
        minWidth: 54,
        maxHeight: "82%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

async function runGo(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/go requires Pi's interactive TUI.", "error");
    return;
  }

  const initialPath = normalizeCommandPath(ctx.cwd, args);
  try {
    if (!statSync(initialPath).isDirectory()) {
      ctx.ui.notify(`Not a directory: ${initialPath}`, "error");
      return;
    }
  } catch {
    ctx.ui.notify(`Directory does not exist: ${initialPath}`, "error");
    return;
  }

  const targetPath = await chooseDirectory(ctx, initialPath);
  if (!targetPath) return;
  try {
    await launchWorkspace(pi, ctx, targetPath);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

export default function goExtension(pi: ExtensionAPI): void {
  pi.registerCommand("go", {
    description: "Browse folders and open a fresh or forked Pi session",
    handler: async (args, ctx) => runGo(pi, args, ctx),
  });
}
