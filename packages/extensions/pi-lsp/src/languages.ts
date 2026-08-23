import { createHash } from "node:crypto";
import { access, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, parse, resolve } from "node:path";
import type { LanguageServerDefinition, ResolvedLanguage } from "./types";

const BAZEL_WORKSPACE_MARKERS = ["MODULE.bazel", "WORKSPACE.bazel", "WORKSPACE"] as const;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findAncestorWithMarker(
  startDirectory: string,
  markers: readonly string[],
): Promise<string | undefined> {
  let directory = resolve(startDirectory);
  while (true) {
    for (const marker of markers) {
      if (await exists(join(directory, marker))) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function findBazelWorkspaceRoot(filePath: string): Promise<string | undefined> {
  return findAncestorWithMarker(dirname(filePath), BAZEL_WORKSPACE_MARKERS);
}

async function findGitRoot(filePath: string): Promise<string | undefined> {
  return findAncestorWithMarker(dirname(filePath), [".git"]);
}

async function detectGoRoot(filePath: string): Promise<string | undefined> {
  const directory = dirname(filePath);
  return (await findAncestorWithMarker(directory, ["go.work"]))
    ?? findAncestorWithMarker(directory, ["go.mod"]);
}

function detectTypeScriptRoot(filePath: string): Promise<string | undefined> {
  return findAncestorWithMarker(dirname(filePath), ["tsconfig.json", "jsconfig.json", "package.json"]);
}

async function javaLaunch(root: string) {
  const rootHash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const dataDirectory = join(tmpdir(), "pi-lsp-jdtls", `${rootHash}-${process.pid}`);
  await mkdir(dataDirectory, { recursive: true });
  return {
    command: "jdtls",
    args: ["-data", dataDirectory],
    cwd: root,
    cleanup: () => rm(dataDirectory, { recursive: true, force: true }),
  };
}

export const LANGUAGE_SERVERS: readonly LanguageServerDefinition[] = [
  {
    id: "go",
    displayName: "Go",
    extensions: { ".go": "go" },
    detectLanguageRoot: detectGoRoot,
    launch: async (root) => ({ command: "gopls", args: ["serve"], cwd: root }),
    initializationTimeoutMs: 30_000,
    requestTimeoutMs: 20_000,
    diagnosticsWaitMs: 2_000,
  },
  {
    id: "java",
    displayName: "Java",
    extensions: { ".java": "java" },
    requiresBazel: true,
    launch: javaLaunch,
    initializationTimeoutMs: 90_000,
    requestTimeoutMs: 30_000,
    diagnosticsWaitMs: 5_000,
  },
  {
    id: "typescript",
    displayName: "TypeScript",
    extensions: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    detectLanguageRoot: detectTypeScriptRoot,
    launch: async (root) => ({
      command: "typescript-language-server",
      args: ["--stdio"],
      cwd: root,
    }),
    initializationTimeoutMs: 30_000,
    requestTimeoutMs: 20_000,
    diagnosticsWaitMs: 2_000,
  },
];

export async function resolveLanguage(
  inputPath: string,
  cwd: string,
  definitions: readonly LanguageServerDefinition[] = LANGUAGE_SERVERS,
): Promise<ResolvedLanguage> {
  const normalizedInput = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  const requestedPath = resolve(cwd, normalizedInput);

  let filePath: string;
  try {
    filePath = await realpath(requestedPath);
  } catch {
    throw new Error(`LSP file does not exist: ${requestedPath}`);
  }

  const extension = extname(filePath).toLowerCase();
  const definition = definitions.find((candidate) => candidate.extensions[extension] !== undefined);
  if (!definition) {
    const supported = [...new Set(definitions.flatMap((candidate) => Object.keys(candidate.extensions)))].sort();
    throw new Error(`Unsupported LSP file type ${extension || "(none)"}. Supported extensions: ${supported.join(", ")}.`);
  }

  const languageId = definition.extensions[extension];
  if (!languageId) throw new Error(`No LSP language ID is configured for ${extension}.`);

  const languageRoot = await definition.detectLanguageRoot?.(filePath, cwd);
  const bazelRoot = languageRoot ? undefined : await findBazelWorkspaceRoot(filePath);
  if (definition.requiresBazel && !bazelRoot) {
    throw new Error(
      `Java LSP support requires a Bazel workspace containing one of: ${BAZEL_WORKSPACE_MARKERS.join(", ")}.`,
    );
  }

  const fallback = languageRoot ?? bazelRoot ?? await findGitRoot(filePath) ?? resolve(cwd);
  let root: string;
  try {
    root = await realpath(fallback);
  } catch {
    root = fallback;
  }

  return { definition, languageId, filePath, root };
}

export function workspaceName(root: string): string {
  return parse(root).base || root;
}
