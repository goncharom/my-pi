import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type {
  Diagnostic,
  DocumentDiagnosticReport,
  DocumentSymbol,
  Hover,
  InitializeParams,
  InitializeResult,
  Location,
  LocationLink,
  Position,
  PublishDiagnosticsParams,
  ServerCapabilities,
  SymbolInformation,
  WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { URI } from "vscode-uri";
import { workspaceName } from "./languages";
import type {
  DiagnosticsResult,
  LanguageServerDefinition,
  NavigationResult,
  QueryOperation,
  ServerLaunch,
  SymbolsResult,
  SyncedDocument,
} from "./types";

const MAX_STDERR_BYTES = 16 * 1024;

interface OpenDocument extends SyncedDocument {}

interface PublishedDiagnostics {
  diagnostics: Diagnostic[];
  version?: number;
  sequence: number;
}

export class LspClient {
  readonly serverId: string;
  readonly root: string;

  private readonly connection: MessageConnection;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly publishedDiagnostics = new Map<string, PublishedDiagnostics>();
  private readonly pullResultIds = new Map<string, string>();
  private readonly dynamicRegistrations = new Map<string, string>();
  private capabilities: ServerCapabilities = {};
  private diagnosticSequence = 0;
  private stderr = "";
  private initialized = false;
  private stopping = false;
  private failureReported = false;

  private constructor(
    private readonly definition: LanguageServerDefinition,
    private readonly launch: ServerLaunch,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onUnexpectedExit: (error: Error) => void,
  ) {
    this.serverId = definition.id;
    this.root = launch.cwd;
    this.connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    this.registerServerHandlers();
    this.captureProcessState();
    this.connection.listen();
  }

  static async start(
    definition: LanguageServerDefinition,
    root: string,
    signal: AbortSignal | undefined,
    onUnexpectedExit: (error: Error) => void,
  ): Promise<LspClient> {
    const launch = await definition.launch(root);
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    try {
      await waitForSpawn(child);
    } catch (error) {
      await launch.cleanup?.().catch(() => undefined);
      const base = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not start ${definition.displayName} LSP (${launch.command}): ${base}`);
    }

    const client = new LspClient(definition, launch, child, onUnexpectedExit);
    try {
      await client.initialize(signal);
      client.initialized = true;
      return client;
    } catch (error) {
      await client.disposeAfterFailure();
      const detail = client.stderr.trim();
      const base = error instanceof Error ? error.message : String(error);
      const suffix = detail ? `\n${detail}` : "";
      throw new Error(`Could not start ${definition.displayName} LSP (${launch.command}): ${base}${suffix}`);
    }
  }

  supports(operation: QueryOperation): boolean {
    const capability = {
      hover: this.capabilities.hoverProvider,
      definition: this.capabilities.definitionProvider,
      declaration: this.capabilities.declarationProvider,
      type_definition: this.capabilities.typeDefinitionProvider,
      implementation: this.capabilities.implementationProvider,
      references: this.capabilities.referencesProvider,
    }[operation];
    return Boolean(capability) || this.hasDynamicRegistration(methodForOperation(operation));
  }

  supportsDocumentSymbols(): boolean {
    return Boolean(this.capabilities.documentSymbolProvider)
      || this.hasDynamicRegistration("textDocument/documentSymbol");
  }

  supportsWorkspaceSymbols(): boolean {
    return Boolean(this.capabilities.workspaceSymbolProvider)
      || this.hasDynamicRegistration("workspace/symbol");
  }

  async query(
    operation: QueryOperation,
    filePath: string,
    languageId: string,
    line: number,
    column: number,
    includeDeclaration: boolean,
    signal?: AbortSignal,
  ): Promise<Hover | NavigationResult> {
    if (!this.supports(operation)) {
      throw new Error(`${this.definition.displayName} LSP does not advertise support for ${operation}.`);
    }

    const document = await this.syncDocument(filePath, languageId);
    const position = lspPosition(document.text, line, column);
    const params = { textDocument: { uri: document.uri }, position };
    const timeout = this.definition.requestTimeoutMs ?? 20_000;

    if (operation === "hover") {
      return this.sendRequest<Hover | null>("textDocument/hover", params, signal, timeout);
    }
    if (operation === "references") {
      return this.sendRequest<Location[] | null>(
        "textDocument/references",
        { ...params, context: { includeDeclaration } },
        signal,
        timeout,
      );
    }
    return this.sendRequest<Location | Location[] | LocationLink[] | null>(
      methodForOperation(operation),
      params,
      signal,
      timeout,
    );
  }

  async documentSymbols(
    filePath: string,
    languageId: string,
    signal?: AbortSignal,
  ): Promise<SymbolsResult> {
    if (!this.supportsDocumentSymbols()) {
      throw new Error(`${this.definition.displayName} LSP does not advertise document symbol support.`);
    }
    const document = await this.syncDocument(filePath, languageId);
    return this.sendRequest<DocumentSymbol[] | SymbolInformation[] | null>(
      "textDocument/documentSymbol",
      { textDocument: { uri: document.uri } },
      signal,
      this.definition.requestTimeoutMs ?? 20_000,
    );
  }

  async workspaceSymbols(
    filePath: string,
    languageId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<SymbolsResult> {
    if (!this.supportsWorkspaceSymbols()) {
      throw new Error(`${this.definition.displayName} LSP does not advertise workspace symbol support.`);
    }
    await this.syncDocument(filePath, languageId);
    return this.sendRequest<Array<SymbolInformation | WorkspaceSymbol> | null>(
      "workspace/symbol",
      { query },
      signal,
      this.definition.requestTimeoutMs ?? 20_000,
    );
  }

  async diagnostics(
    filePath: string,
    languageId: string,
    signal?: AbortSignal,
  ): Promise<DiagnosticsResult> {
    const uri = URI.file(filePath).toString();
    const sequenceBeforeSync = this.publishedDiagnostics.get(uri)?.sequence ?? 0;
    const document = await this.syncDocument(filePath, languageId);

    if (this.capabilities.diagnosticProvider || this.hasDynamicRegistration("textDocument/diagnostic")) {
      const previousResultId = this.pullResultIds.get(uri);
      const report = await this.sendRequest<DocumentDiagnosticReport>(
        "textDocument/diagnostic",
        {
          textDocument: { uri },
          ...(previousResultId ? { previousResultId } : {}),
        },
        signal,
        this.definition.requestTimeoutMs ?? 20_000,
      );
      if (report.resultId) this.pullResultIds.set(uri, report.resultId);
      if (report.kind === "full") {
        this.publishedDiagnostics.set(uri, {
          diagnostics: report.items,
          version: document.version,
          sequence: ++this.diagnosticSequence,
        });
        return { diagnostics: report.items, fresh: true, source: "pull" };
      }
      return {
        diagnostics: this.publishedDiagnostics.get(uri)?.diagnostics ?? [],
        fresh: true,
        source: "pull",
      };
    }

    const immediate = this.publishedDiagnostics.get(uri);
    if (immediate && (immediate.sequence > sequenceBeforeSync || !document.changed)) {
      return { diagnostics: immediate.diagnostics, fresh: true, source: "push" };
    }

    const deadline = Date.now() + (this.definition.diagnosticsWaitMs ?? 2_000);
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("LSP diagnostics request was cancelled.");
      await abortableDelay(Math.min(50, Math.max(1, deadline - Date.now())), signal);
      const update = this.publishedDiagnostics.get(uri);
      if (update && update.sequence > sequenceBeforeSync) {
        return { diagnostics: update.diagnostics, fresh: true, source: "push" };
      }
    }

    return {
      diagnostics: this.publishedDiagnostics.get(uri)?.diagnostics ?? [],
      fresh: false,
      source: "cache",
    };
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    for (const document of this.documents.values()) {
      try {
        this.connection.sendNotification("textDocument/didClose", {
          textDocument: { uri: document.uri },
        });
      } catch {}
    }

    if (this.child.exitCode === null && this.child.signalCode === null) {
      try {
        await this.sendRequest<null>("shutdown", undefined, undefined, 2_000);
        this.connection.sendNotification("exit");
      } catch {}
      if (!(await waitForExit(this.child, 1_000))) {
        this.child.kill("SIGTERM");
        if (!(await waitForExit(this.child, 500))) this.child.kill("SIGKILL");
      }
    }

    this.connection.dispose();
    await this.launch.cleanup?.().catch(() => undefined);
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    const params: InitializeParams = {
      processId: process.pid,
      clientInfo: { name: "pi-lsp", version: "0.1.0" },
      rootUri: URI.file(this.root).toString(),
      workspaceFolders: [{ uri: URI.file(this.root).toString(), name: workspaceName(this.root) }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          symbol: {
            dynamicRegistration: true,
            resolveSupport: { properties: ["location.range"] },
          },
          diagnostics: { refreshSupport: false },
        },
        textDocument: {
          synchronization: { dynamicRegistration: true, didSave: true },
          hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: true, linkSupport: true },
          declaration: { dynamicRegistration: true, linkSupport: true },
          typeDefinition: { dynamicRegistration: true, linkSupport: true },
          implementation: { dynamicRegistration: true, linkSupport: true },
          references: { dynamicRegistration: true },
          documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: { valueSet: [1, 2] },
            versionSupport: true,
          },
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
        },
        window: { workDoneProgress: true },
      },
      initializationOptions: this.definition.initializationOptions,
    };

    const result = await this.sendRequest<InitializeResult>(
      "initialize",
      params,
      signal,
      this.definition.initializationTimeoutMs ?? 30_000,
    );
    this.capabilities = result.capabilities;
    this.connection.sendNotification("initialized", {});
  }

  private async syncDocument(
    filePath: string,
    languageId: string,
  ): Promise<SyncedDocument & { changed: boolean }> {
    const text = await readFile(filePath, "utf8");
    const uri = URI.file(filePath).toString();
    const current = this.documents.get(uri);

    if (!current) {
      const document = { uri, filePath, languageId, text, version: 1 };
      this.documents.set(uri, document);
      this.connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version: document.version, text },
      });
      return { ...document, changed: true };
    }

    const changed = current.text !== text;
    if (changed) {
      current.text = text;
      current.version += 1;
      this.connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: current.version },
        contentChanges: [{ text }],
      });
    }
    return { ...current, changed };
  }

  private registerServerHandlers(): void {
    this.connection.onRequest("workspace/configuration", (raw: unknown) => {
      const params = raw as { items?: unknown[] };
      return (params.items ?? []).map(() => ({}));
    });
    this.connection.onRequest("client/registerCapability", (raw: unknown) => {
      const params = raw as { registrations?: Array<{ id: string; method: string }> };
      for (const registration of params.registrations ?? []) {
        this.dynamicRegistrations.set(registration.id, registration.method);
      }
      return null;
    });
    this.connection.onRequest("client/unregisterCapability", (raw: unknown) => {
      const params = raw as { unregisterations?: Array<{ id: string }>; unregistrations?: Array<{ id: string }> };
      for (const registration of params.unregisterations ?? params.unregistrations ?? []) {
        this.dynamicRegistrations.delete(registration.id);
      }
      return null;
    });
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("window/showMessageRequest", () => null);
    this.connection.onRequest("workspace/workspaceFolders", () => [
      { uri: URI.file(this.root).toString(), name: workspaceName(this.root) },
    ]);
    this.connection.onRequest("workspace/applyEdit", () => ({
      applied: false,
      failureReason: "pi-lsp is read-only",
    }));
    this.connection.onRequest("workspace/executeClientCommand", () => null);
    this.connection.onRequest("workspace/diagnostic/refresh", () => null);
    this.connection.onNotification("textDocument/publishDiagnostics", (raw: unknown) => {
      const params = raw as PublishDiagnosticsParams;
      this.publishedDiagnostics.set(params.uri, {
        diagnostics: params.diagnostics,
        version: params.version,
        sequence: ++this.diagnosticSequence,
      });
    });
  }

  private captureProcessState(): void {
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    this.child.on("error", (error) => {
      if (this.initialized && !this.stopping) this.reportUnexpectedExit(error);
    });
    this.child.on("exit", (code, signal) => {
      if (!this.stopping && this.initialized) {
        const detail = this.stderr.trim();
        this.reportUnexpectedExit(new Error(
          `${this.definition.displayName} LSP exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`})${detail ? `: ${detail}` : ""}`,
        ));
      }
    });
    this.connection.onClose(() => {
      if (!this.stopping && this.initialized) {
        this.reportUnexpectedExit(new Error(`${this.definition.displayName} LSP connection closed unexpectedly.`));
      }
    });
  }

  private reportUnexpectedExit(error: Error): void {
    if (this.failureReported) return;
    this.failureReported = true;
    this.onUnexpectedExit(error);
  }

  private hasDynamicRegistration(method: string): boolean {
    return [...this.dynamicRegistrations.values()].includes(method);
  }

  private async sendRequest<R>(
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<R> {
    if (signal?.aborted) throw new Error(`LSP request ${method} was cancelled.`);
    const tokenSource = new CancellationTokenSource();
    let timedOut = false;
    const onAbort = () => tokenSource.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      tokenSource.cancel();
    }, timeoutMs);

    try {
      return await this.connection.sendRequest<R>(method, params, tokenSource.token);
    } catch (error) {
      if (timedOut) throw new Error(`LSP request ${method} timed out after ${timeoutMs}ms.`);
      if (signal?.aborted) throw new Error(`LSP request ${method} was cancelled.`);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      tokenSource.dispose();
    }
  }

  private async disposeAfterFailure(): Promise<void> {
    this.stopping = true;
    this.connection.dispose();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      if (!(await waitForExit(this.child, 500))) this.child.kill("SIGKILL");
    }
    await this.launch.cleanup?.().catch(() => undefined);
  }
}

function methodForOperation(operation: QueryOperation): string {
  return {
    hover: "textDocument/hover",
    definition: "textDocument/definition",
    declaration: "textDocument/declaration",
    type_definition: "textDocument/typeDefinition",
    implementation: "textDocument/implementation",
    references: "textDocument/references",
  }[operation];
}

function lspPosition(text: string, line: number, column: number): Position {
  if (!Number.isInteger(line) || line < 1) throw new Error("line must be a positive 1-based integer.");
  if (!Number.isInteger(column) || column < 1) throw new Error("column must be a positive 1-based integer.");
  const lines = text.split(/\r\n|\n|\r/);
  if (line > lines.length) throw new Error(`line ${line} is outside the file (last line: ${lines.length}).`);
  const sourceLine = lines[line - 1];
  if (column > sourceLine.length + 1) {
    throw new Error(`column ${column} is outside line ${line} (last column: ${sourceLine.length + 1}).`);
  }
  return { line: line - 1, character: column - 1 };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) {
      reject(new Error("LSP operation was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("LSP operation was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveSpawn, reject) => {
    const onSpawn = () => {
      child.removeListener("error", onError);
      resolveSpawn();
    };
    const onError = (error: Error) => {
      child.removeListener("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveWait(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveWait(true);
    };
    child.once("exit", onExit);
  });
}
