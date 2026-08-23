import { LspClient } from "./client";
import { LANGUAGE_SERVERS, resolveLanguage } from "./languages";
import type {
  DiagnosticsResponse,
  LanguageServerDefinition,
  LspManagerStatus,
  QueryOperation,
  QueryResponse,
  ResolvedLanguage,
  SymbolsResponse,
} from "./types";

export class LspManager {
  private readonly clients = new Map<string, LspClient>();
  private readonly pending = new Map<string, Promise<LspClient>>();
  private readonly shutdownController = new AbortController();
  private closed = false;

  constructor(
    private readonly cwd: string,
    private readonly onStatus: (status: LspManagerStatus) => void = () => undefined,
    private readonly definitions: readonly LanguageServerDefinition[] = LANGUAGE_SERVERS,
  ) {
    this.onStatus({ state: "idle" });
  }

  async query(
    operation: QueryOperation,
    path: string,
    line: number,
    column: number,
    includeDeclaration: boolean,
    signal?: AbortSignal,
  ): Promise<QueryResponse> {
    const resolved = await this.resolve(path);
    const client = await this.clientFor(resolved, signal);
    const value = await client.query(
      operation,
      resolved.filePath,
      resolved.languageId,
      line,
      column,
      includeDeclaration,
      signal,
    );
    return {
      operation,
      value,
      filePath: resolved.filePath,
      server: resolved.definition.id,
      root: resolved.root,
    };
  }

  async symbols(path: string, query: string | undefined, signal?: AbortSignal): Promise<SymbolsResponse> {
    const resolved = await this.resolve(path);
    const client = await this.clientFor(resolved, signal);
    if (query === undefined) {
      const value = await client.documentSymbols(resolved.filePath, resolved.languageId, signal);
      return {
        value,
        scope: "document",
        filePath: resolved.filePath,
        server: resolved.definition.id,
        root: resolved.root,
      };
    }
    const value = await client.workspaceSymbols(resolved.filePath, resolved.languageId, query, signal);
    return {
      value,
      scope: "workspace",
      filePath: resolved.filePath,
      server: resolved.definition.id,
      root: resolved.root,
    };
  }

  async diagnostics(path: string, signal?: AbortSignal): Promise<DiagnosticsResponse> {
    const resolved = await this.resolve(path);
    const client = await this.clientFor(resolved, signal);
    const result = await client.diagnostics(resolved.filePath, resolved.languageId, signal);
    return {
      ...result,
      filePath: resolved.filePath,
      server: resolved.definition.id,
      root: resolved.root,
    };
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shutdownController.abort();
    await Promise.allSettled(this.pending.values());
    await Promise.allSettled([...this.clients.values()].map((client) => client.shutdown()));
    this.pending.clear();
    this.clients.clear();
    this.onStatus({ state: "idle" });
  }

  private resolve(path: string): Promise<ResolvedLanguage> {
    if (this.closed) throw new Error("The LSP manager is shutting down.");
    return resolveLanguage(path, this.cwd, this.definitions);
  }

  private async clientFor(resolved: ResolvedLanguage, signal?: AbortSignal): Promise<LspClient> {
    if (this.closed) throw new Error("The LSP manager is shutting down.");
    const key = `${resolved.definition.id}\0${resolved.root}`;
    const existing = this.clients.get(key);
    if (existing) return existing;
    const starting = this.pending.get(key);
    if (starting) return starting;

    this.onStatus({ state: "starting", language: resolved.definition.id });
    const combinedSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;

    const promise = LspClient.start(
      resolved.definition,
      resolved.root,
      combinedSignal,
      () => this.handleUnexpectedExit(key, resolved.definition.id),
    ).then((client) => {
      if (this.closed) {
        void client.shutdown();
        throw new Error("The LSP manager shut down while the server was starting.");
      }
      this.clients.set(key, client);
      this.onStatus({ state: "ready", count: this.clients.size });
      return client;
    }).catch((error) => {
      if (!this.closed) this.onStatus({ state: "error", language: resolved.definition.id });
      throw error;
    }).finally(() => {
      this.pending.delete(key);
    });

    this.pending.set(key, promise);
    return promise;
  }

  private handleUnexpectedExit(key: string, language: string): void {
    this.clients.delete(key);
    if (!this.closed) this.onStatus({ state: "error", language });
  }
}
