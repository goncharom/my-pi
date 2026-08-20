export interface ZellijPane {
  id: number;
  is_plugin: boolean;
  is_focused: boolean;
  is_fullscreen: boolean;
  is_floating: boolean;
  is_suppressed: boolean;
  is_pinned?: boolean;
  title: string;
  exited: boolean;
  exit_status: number | null;
  is_held: boolean;
  tab_id: number;
  tab_position: number;
  tab_name: string;
  pane_command?: string;
  pane_cwd?: string;
  [key: string]: unknown;
}

export interface ZellijTab {
  position: number;
  name: string;
  active: boolean;
  tab_id: number;
  are_floating_panes_visible?: boolean;
  [key: string]: unknown;
}

export interface ZellijClientInfo {
  clientId: string;
  paneId: string;
  runningCommand: string;
}

interface ExecOptions {
  signal?: AbortSignal;
  timeout?: number;
  cwd?: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const RETRYABLE_ACTIONS = new Set([
  "are-floating-panes-visible",
  "current-tab-info",
  "dump-screen",
  "list-clients",
  "list-panes",
  "list-tabs",
]);

export class ZellijClient {
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly execute: Exec,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  get sessionName(): string {
    const name = this.environment.ZELLIJ_SESSION_NAME?.trim();
    if (!name) throw new Error("Pi is not running inside a Zellij session (ZELLIJ_SESSION_NAME is not set).");
    return name;
  }

  get originPaneId(): string | undefined {
    const id = this.environment.ZELLIJ_PANE_ID?.trim();
    return id ? normalizePaneId(id) : undefined;
  }

  async run(args: string[], signal?: AbortSignal, timeout = 10_000): Promise<string> {
    const operation = this.commandQueue.then(() => this.runCommand(args, signal, timeout));
    this.commandQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async listPanes(signal?: AbortSignal): Promise<ZellijPane[]> {
    return this.readJsonArray<ZellijPane>(["action", "list-panes", "--json"], "pane list", signal);
  }

  async listTabs(signal?: AbortSignal): Promise<ZellijTab[]> {
    return this.readJsonArray<ZellijTab>(["action", "list-tabs", "--json"], "tab list", signal);
  }

  async listClients(signal?: AbortSignal): Promise<ZellijClientInfo[]> {
    let output = await this.run(["action", "list-clients"], signal);
    if (!output.trim()) {
      await abortableDelay(100, signal);
      output = await this.run(["action", "list-clients"], signal);
    }
    return output
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => /^(\S+)\s+(\S+)\s*(.*)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => ({ clientId: match[1], paneId: match[2], runningCommand: match[3] }));
  }

  async readPane(paneId: string, options: { full?: boolean; ansi?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    const args = ["action", "dump-screen", "--pane-id", normalizePaneId(paneId)];
    if (options.full) args.push("--full");
    if (options.ansi) args.push("--ansi");
    let output = await this.run(args, options.signal);
    if (!output) {
      await abortableDelay(100, options.signal);
      output = await this.run(args, options.signal);
    }
    return output;
  }

  async findPane(paneId: string, signal?: AbortSignal): Promise<ZellijPane | undefined> {
    const normalized = normalizePaneId(paneId);
    return (await this.listPanes(signal)).find((pane) => paneIdFor(pane) === normalized);
  }

  async findTab(tabId: number, signal?: AbortSignal): Promise<ZellijTab | undefined> {
    return (await this.listTabs(signal)).find((tab) => tab.tab_id === tabId);
  }

  private async readJsonArray<T>(args: string[], label: string, signal?: AbortSignal): Promise<T[]> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return parseJsonArray<T>(await this.run(args, signal), label);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await abortableDelay(100, signal);
      }
    }
    throw lastError;
  }

  private async runCommand(args: string[], signal: AbortSignal | undefined, timeout: number): Promise<string> {
    const attempts = isRetryable(args) ? 2 : 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) throw new Error("Zellij command was cancelled.");
      const result = await this.execute("zellij", ["--session", this.sessionName, ...args], { signal, timeout });
      if (signal?.aborted) throw new Error("Zellij command was cancelled.");
      if (result.killed) throw new Error(`Zellij command was terminated or timed out after ${timeout}ms.`);
      if (result.code === 0) return result.stdout;

      const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
      if (attempt < attempts && isTransientFailure(reason)) {
        await abortableDelay(100, signal);
        continue;
      }
      throw new Error(`Zellij command failed: ${reason}`);
    }

    throw new Error("Zellij command failed unexpectedly.");
  }
}

export function normalizePaneId(value: string): string {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return `terminal_${trimmed}`;
  if (/^(terminal|plugin)_\d+$/.test(trimmed)) return trimmed;
  throw new Error(`Invalid Zellij pane ID: ${value}`);
}

export function paneIdFor(pane: Pick<ZellijPane, "id" | "is_plugin">): string {
  return `${pane.is_plugin ? "plugin" : "terminal"}_${pane.id}`;
}

function isRetryable(args: string[]): boolean {
  return args[0] === "action" && RETRYABLE_ACTIONS.has(args[1]);
}

function isTransientFailure(reason: string): boolean {
  return /session .+ not found|connection (?:refused|reset)|failed to connect|temporar(?:y|ily)|would block/i.test(reason);
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) {
      reject(new Error("Zellij command was cancelled."));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Zellij command was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseJsonArray<T>(output: string, label: string): T[] {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!Array.isArray(parsed)) throw new Error("expected an array");
    return parsed as T[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse Zellij ${label}: ${message}`);
  }
}
