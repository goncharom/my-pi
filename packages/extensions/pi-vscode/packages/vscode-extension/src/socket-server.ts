import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  NdjsonFramer,
  parsePiToVSCodeMessage,
  type ErrorMessage,
  type PrefillResultMessage,
  type ProtocolMessage,
  writeMessage,
} from "../../pi-extension/src/protocol";
import type { InstanceRegistryEntry } from "./instance-registry";
import type { PlanStore } from "./plan-store";

export interface ConnectedPi {
  socket: net.Socket;
  cwd: string;
  repoRoot?: string;
  sessionName?: string;
  pid: number;
  connectedAt: number;
}

type ConnectionChangeListener = (connected: ConnectedPi | undefined) => void;

interface PendingPrefill {
  resolve: (message: PrefillResultMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class SocketServer implements vscode.Disposable {
  private server?: net.Server;
  private active?: ConnectedPi;
  private pendingPrefill?: PendingPrefill;
  private disposed = false;

  constructor(
    private readonly entry: InstanceRegistryEntry,
    private readonly planStore: PlanStore,
    private readonly onConnectionChange: ConnectionChangeListener,
  ) {}

  get connectedPi(): ConnectedPi | undefined {
    return this.active;
  }

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.entry.socketPath), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(this.entry.socketPath), 0o700).catch(() => undefined);
    await fs.unlink(this.entry.socketPath).catch(() => undefined);

    this.server = net.createServer((socket) => this.handleSocket(socket));

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.entry.socketPath);
    });

    await fs.chmod(this.entry.socketPath, 0o600).catch(() => undefined);
  }

  async sendPrefill(text: string): Promise<PrefillResultMessage> {
    if (!this.active || this.active.socket.destroyed) {
      throw new Error("No Pi session is connected. Run /vscode-connect in the master Pi terminal.");
    }
    if (this.pendingPrefill) {
      throw new Error("A review is already being sent to Pi.");
    }

    return new Promise<PrefillResultMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingPrefill = undefined;
        reject(new Error("Timed out waiting for Pi to acknowledge the prefill."));
      }, 30_000);

      this.pendingPrefill = { resolve, reject, timeout };

      try {
        this.write(this.active!.socket, { type: "prefill", text });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingPrefill = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  disconnect(): void {
    const socket = this.active?.socket;
    if (!socket) return;
    this.clearActive(socket);
    socket.end();
    socket.destroySoon?.();
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.server?.close();
    this.server = undefined;
    void fs.unlink(this.entry.socketPath).catch(() => undefined);
  }

  private handleSocket(socket: net.Socket): void {
    const framer = new NdjsonFramer();
    let connectedOnThisSocket = false;

    socket.setEncoding("utf8");

    socket.on("data", async (chunk) => {
      try {
        const rawMessages = framer.push(chunk);
        for (const rawMessage of rawMessages) {
          const message = parsePiToVSCodeMessage(rawMessage);

          if (message.type === "connect") {
            if (connectedOnThisSocket) {
              this.sendError(socket, "INVALID_MESSAGE", "This socket is already connected.");
              continue;
            }

            if (message.token !== this.entry.authToken) {
              this.sendError(socket, "INVALID_TOKEN", "Invalid VS Code connection token.");
              socket.end();
              return;
            }

            if (this.active && this.active.socket !== socket) {
              this.sendError(socket, "ALREADY_CONNECTED", "Another Pi session is already connected.");
              socket.end();
              return;
            }

            connectedOnThisSocket = true;
            this.active = {
              socket,
              cwd: message.cwd,
              repoRoot: message.repoRoot,
              sessionName: message.sessionName,
              pid: message.pid,
              connectedAt: Date.now(),
            };
            this.onConnectionChange(this.active);
            this.write(socket, { type: "connected", instanceId: this.entry.instanceId, displayName: this.entry.displayName });
            continue;
          }

          if (!connectedOnThisSocket || this.active?.socket !== socket) {
            this.sendError(socket, "NOT_CONNECTED", "This socket is not the active Pi controller.");
            continue;
          }

          if (message.type === "disconnect") {
            this.clearActive(socket);
            socket.end();
            continue;
          }

          if (message.type === "prefillResult") {
            this.resolvePrefill(message);
            continue;
          }

          if (message.type === "publishPlan") {
            try {
              const published = await this.planStore.publishPlan(message.title, message.markdown, message.planId);
              this.write(socket, {
                type: "planPublished",
                planId: published.planId,
                version: published.version,
                uri: published.uri.toString(),
              });
            } catch (error) {
              this.sendError(socket, "INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
            }
            continue;
          }

          this.sendError(socket, "INVALID_MESSAGE", "Unsupported message.");
        }
      } catch (error) {
        this.sendError(socket, "INVALID_MESSAGE", error instanceof Error ? error.message : String(error));
      }
    });

    socket.on("close", () => {
      if (connectedOnThisSocket) {
        this.clearActive(socket);
      }
    });

    socket.on("error", () => {
      if (connectedOnThisSocket) {
        this.clearActive(socket);
      }
    });
  }

  private resolvePrefill(message: PrefillResultMessage): void {
    const pending = this.pendingPrefill;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingPrefill = undefined;
    pending.resolve(message);
  }

  private rejectPrefill(error: Error): void {
    const pending = this.pendingPrefill;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingPrefill = undefined;
    pending.reject(error);
  }

  private clearActive(socket: net.Socket): void {
    if (this.active?.socket !== socket) return;
    this.active = undefined;
    this.rejectPrefill(new Error("Pi disconnected before acknowledging the prefill."));
    this.onConnectionChange(undefined);
  }

  private sendError(socket: net.Socket, code: ErrorMessage["code"], message: string): void {
    this.write(socket, { type: "error", code, message });
  }

  private write(socket: net.Socket, message: ProtocolMessage): void {
    writeMessage(socket, message);
  }
}
