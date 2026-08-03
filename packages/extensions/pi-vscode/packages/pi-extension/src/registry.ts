import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export interface VSCodeRegistryEntry {
  protocolVersion: 1;
  instanceId: string;
  pid: number;
  socketPath: string;
  authToken: string;
  workspaceRoots: string[];
  displayName: string;
}

interface RuntimePaths {
  baseDir: string;
  instancesDir: string;
}

export function getRuntimePaths(): RuntimePaths {
  const baseDir = process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, "pi-vscode-review")
    : path.join(os.homedir(), ".local", "state", "pi-vscode-review", "runtime");

  return {
    baseDir,
    instancesDir: path.join(baseDir, "instances"),
  };
}

export async function readRegistryEntries(): Promise<VSCodeRegistryEntry[]> {
  const { instancesDir } = getRuntimePaths();
  const names = await fs.readdir(instancesDir).catch(() => [] as string[]);
  const entries: VSCodeRegistryEntry[] = [];

  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(instancesDir, name);
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw) as VSCodeRegistryEntry;
      if (isRegistryEntry(parsed)) entries.push(parsed);
    } catch {
      // Ignore corrupt or concurrently removed entries.
    }
  }

  return entries;
}

export async function filterReachableEntries(entries: VSCodeRegistryEntry[]): Promise<VSCodeRegistryEntry[]> {
  const checks = await Promise.all(entries.map(async (entry) => ((await canConnect(entry.socketPath)) ? entry : undefined)));
  return checks.filter((entry): entry is VSCodeRegistryEntry => Boolean(entry));
}

export function findWorkspaceMatches(
  entries: VSCodeRegistryEntry[],
  cwd: string,
  repoRoot: string | undefined,
): VSCodeRegistryEntry[] {
  const candidates = [cwd, repoRoot].filter((value): value is string => Boolean(value));

  return entries.filter((entry) =>
    entry.workspaceRoots.some((workspaceRoot) => candidates.some((candidate) => containsPath(workspaceRoot, candidate))),
  );
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function isRegistryEntry(value: unknown): value is VSCodeRegistryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<VSCodeRegistryEntry>;
  return (
    entry.protocolVersion === 1 &&
    typeof entry.instanceId === "string" &&
    typeof entry.pid === "number" &&
    typeof entry.socketPath === "string" &&
    typeof entry.authToken === "string" &&
    Array.isArray(entry.workspaceRoots) &&
    entry.workspaceRoots.every((root) => typeof root === "string") &&
    typeof entry.displayName === "string"
  );
}
