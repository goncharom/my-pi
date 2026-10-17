import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function readPrompts(cwd: string): string[] {
  const projectFiles: string[] = [];
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    projectFiles.unshift(join(directory, ".pi", "extra-prompts.md"));
    if (dirname(directory) === directory) break;
  }
  const files = new Set([resolve(getAgentDir(), "extra-prompts.md"), ...projectFiles]);
  return [...files]
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8").trim())
    .filter(Boolean);
}

function githubRepository(remote: string): string | undefined {
  const match = remote.trim().match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)\/?$/i,
  );
  if (!match) return undefined;
  return `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}`;
}

async function workspaceContext(pi: ExtensionAPI, cwd: string): Promise<string> {
  try {
    const [remote, revision] = await Promise.all([
      pi.exec("git", ["remote", "get-url", "origin"], { cwd, timeout: 2_000 }),
      pi.exec("git", ["rev-parse", "--show-toplevel", "HEAD"], { cwd, timeout: 2_000 }),
    ]);
    if (remote.code !== 0 || revision.code !== 0) return "";
    const repository = githubRepository(remote.stdout);
    const [root, commit] = revision.stdout.trim().split(/\r?\n/);
    if (!repository || !root || !/^[a-f0-9]{40,64}$/.test(commit ?? "")) return "";
    return [
      "## Workspace source links",
      `Repository root: ${root}`,
      `Working directory: ${cwd}`,
      `GitHub repository: ${repository}`,
      `Source URL prefix: ${repository}/blob/${commit}/`,
      "This is a local HEAD snapshot, not verification that the commit is published on GitHub.",
    ].join("\n");
  } catch {
    // Git is optional; a missing executable or remote must not block requests.
    return "";
  }
}

export default function extraPromptsExtension(pi: ExtensionAPI): void {
  let instructions = "";

  pi.on("session_start", async (_event, ctx) => {
    instructions = "";
    const prompts = readPrompts(ctx.cwd);
    if (prompts.length === 0) return;
    const workspace = await workspaceContext(pi, ctx.cwd);
    instructions = [...prompts, workspace].filter(Boolean).join("\n\n");
  });

  // Unlike before_agent_start, context fires for every model call, including
  // tool-loop continuations. This hidden message is request-local: it is never
  // appended to the session, compacted away, or accumulated across requests.
  pi.on("context", (event) => {
    if (!instructions) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom" as const,
          customType: "extra-prompts",
          content: `Apply these additional instructions to the user's task above. Do not acknowledge this reminder or treat it as a new task.\n\n${instructions}`,
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
}
