import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "../../pi-extension/src/protocol";

export interface InstanceRegistryEntry {
  protocolVersion: 1;
  instanceId: string;
  pid: number;
  socketPath: string;
  authToken: string;
  workspaceRoots: string[];
  displayName: string;
}

export interface RuntimePaths {
  baseDir: string;
  instancesDir: string;
  socketsDir: string;
}

export function getRuntimePaths(): RuntimePaths {
  const baseDir = process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, "pi-vscode-review")
    : path.join(os.homedir(), ".local", "state", "pi-vscode-review", "runtime");

  return {
    baseDir,
    instancesDir: path.join(baseDir, "instances"),
    socketsDir: path.join(baseDir, "sockets"),
  };
}

export async function createRuntimeDirs(paths: RuntimePaths): Promise<void> {
  await fs.mkdir(paths.instancesDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.socketsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.baseDir, 0o700).catch(() => undefined);
  await fs.chmod(paths.instancesDir, 0o700).catch(() => undefined);
  await fs.chmod(paths.socketsDir, 0o700).catch(() => undefined);
}

export function createInstanceEntry(): InstanceRegistryEntry {
  const paths = getRuntimePaths();
  const instanceId = crypto.randomBytes(16).toString("hex");
  const authToken = crypto.randomBytes(32).toString("hex");
  const workspaceRoots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const workspaceName = vscode.workspace.name ?? path.basename(workspaceRoots[0] ?? "VS Code");
  const remoteSuffix = vscode.env.remoteName ? ` — ${vscode.env.remoteName}` : "";

  return {
    protocolVersion: PROTOCOL_VERSION,
    instanceId,
    pid: process.pid,
    socketPath: path.join(paths.socketsDir, `${instanceId}.sock`),
    authToken,
    workspaceRoots,
    displayName: `${workspaceName}${remoteSuffix}`,
  };
}

export async function writeRegistryEntry(entry: InstanceRegistryEntry): Promise<string> {
  const paths = getRuntimePaths();
  await createRuntimeDirs(paths);

  const target = path.join(paths.instancesDir, `${entry.instanceId}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temp, 0o600).catch(() => undefined);
  await fs.rename(temp, target);
  return target;
}

export async function deleteRegistryEntry(instanceId: string): Promise<void> {
  const paths = getRuntimePaths();
  await fs.unlink(path.join(paths.instancesDir, `${instanceId}.json`)).catch(() => undefined);
}
