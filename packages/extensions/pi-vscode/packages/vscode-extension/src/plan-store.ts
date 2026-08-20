import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

export interface PlanMetadata {
  planId: string;
  version: number;
  title: string;
  documentHash: string;
  createdAt: string;
}

export interface PublishedPlan {
  planId: string;
  version: number;
  uri: vscode.Uri;
  metadata: PlanMetadata;
}

export class PlanStore {
  private readonly plansByUri = new Map<string, PlanMetadata>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async restore(): Promise<void> {
    const storageUri = this.context.storageUri ?? this.context.globalStorageUri;
    const plansRoot = vscode.Uri.joinPath(storageUri, "plans");
    const planDirs = await fs.readdir(plansRoot.fsPath, { withFileTypes: true }).catch(() => []);

    for (const dir of planDirs) {
      if (!dir.isDirectory()) continue;
      const planDir = path.join(plansRoot.fsPath, dir.name);
      const names = await fs.readdir(planDir).catch(() => [] as string[]);

      for (const name of names) {
        if (!/^v\d+\.json$/.test(name)) continue;
        try {
          const metadata = JSON.parse(await fs.readFile(path.join(planDir, name), "utf8")) as PlanMetadata;
          const markdownUri = vscode.Uri.file(path.join(planDir, `v${metadata.version}.md`));
          this.plansByUri.set(markdownUri.toString(), metadata);
        } catch {
          // Ignore corrupt metadata.
        }
      }
    }
  }

  async publishPlan(title: string, markdown: string, planId?: string): Promise<PublishedPlan> {
    const resolvedPlanId = planId ?? crypto.randomUUID();
    validatePlanId(resolvedPlanId);

    const storageUri = this.context.storageUri ?? this.context.globalStorageUri;
    const plansRoot = vscode.Uri.joinPath(storageUri, "plans", resolvedPlanId);
    await fs.mkdir(plansRoot.fsPath, { recursive: true });

    const version = await this.nextVersion(plansRoot.fsPath);
    const documentHash = hashText(markdown);
    const metadata: PlanMetadata = {
      planId: resolvedPlanId,
      version,
      title,
      documentHash,
      createdAt: new Date().toISOString(),
    };

    const markdownUri = vscode.Uri.joinPath(plansRoot, `v${version}.md`);
    const metadataUri = vscode.Uri.joinPath(plansRoot, `v${version}.json`);

    await fs.writeFile(markdownUri.fsPath, markdown, { encoding: "utf8", flag: "wx" });
    await fs.writeFile(metadataUri.fsPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

    this.plansByUri.set(markdownUri.toString(), metadata);

    void this.showPlan(markdownUri);

    return {
      planId: resolvedPlanId,
      version,
      uri: markdownUri,
      metadata,
    };
  }

  isPublishedPlan(uri: vscode.Uri): boolean {
    return this.plansByUri.has(uri.toString());
  }

  getMetadata(uri: vscode.Uri): PlanMetadata | undefined {
    return this.plansByUri.get(uri.toString());
  }

  private async showPlan(uri: vscode.Uri): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Plan was published, but VS Code could not open it: ${message}`);
    }
  }

  private async nextVersion(planDir: string): Promise<number> {
    const names = await fs.readdir(planDir).catch(() => [] as string[]);
    const versions = names
      .map((name) => /^v(\d+)\.md$/.exec(name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);

    return versions.length === 0 ? 1 : Math.max(...versions) + 1;
  }
}

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function validatePlanId(planId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(planId)) {
    throw new Error("planId may only contain letters, numbers, dots, underscores, and hyphens.");
  }
}
