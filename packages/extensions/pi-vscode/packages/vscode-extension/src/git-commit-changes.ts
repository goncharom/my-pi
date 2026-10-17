import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommitChanges {
  repositoryRoot: string;
  originalRef: string;
  modifiedRef: string;
  files: { originalPath?: string; modifiedPath?: string }[];
}

export interface CommitChangesSeed {
  filePath: string;
  originalRef?: string;
  modifiedRef: string;
}

/** Read the exact revision pair shown by a commit Changes editor, including one-sided files. */
export async function readCommitChanges(seed: CommitChangesSeed): Promise<CommitChanges> {
  const cwd = await existingDirectory(path.dirname(seed.filePath));
  const repositoryRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const modifiedRef = (await git(repositoryRoot, ["rev-parse", "--verify", `${seed.modifiedRef}^{commit}`])).trim();
  let originalRef = seed.originalRef;
  if (!originalRef) {
    const parents = (await git(repositoryRoot, ["show", "-s", "--format=%P", modifiedRef])).trim();
    originalRef = parents.split(" ")[0];
    if (!originalRef) {
      const format = (await git(repositoryRoot, ["rev-parse", "--show-object-format"])).trim();
      originalRef = createHash(format).update("tree 0\0").digest("hex");
    }
  }
  originalRef = (await git(repositoryRoot, ["rev-parse", "--verify", originalRef])).trim();

  const output = await git(repositoryRoot, ["diff", "--name-status", "-z", "--find-renames", originalRef, modifiedRef, "--"]);
  return { repositoryRoot, originalRef, modifiedRef, files: parseNameStatus(output) };
}

function parseNameStatus(output: string): CommitChanges["files"] {
  const fields = output.split("\0");
  const files: CommitChanges["files"] = [];
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    const filePath = fields[index++];
    if (!filePath) throw new Error("Invalid Git changes output.");
    switch (status[0]) {
      case "A": files.push({ modifiedPath: filePath }); break;
      case "D": files.push({ originalPath: filePath }); break;
      case "R":
      case "C": {
        const modifiedPath = fields[index++];
        if (!modifiedPath) throw new Error("Invalid Git rename output.");
        files.push({ originalPath: filePath, modifiedPath });
        break;
      }
      default: files.push({ originalPath: filePath, modifiedPath: filePath });
    }
  }
  return files;
}

async function existingDirectory(directory: string): Promise<string> {
  for (;;) {
    if ((await fs.stat(directory).catch(() => undefined))?.isDirectory()) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Cannot locate the Git repository.");
    directory = parent;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
