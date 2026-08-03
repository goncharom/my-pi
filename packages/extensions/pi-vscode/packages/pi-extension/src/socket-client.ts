import * as net from "node:net";
import {
  NdjsonFramer,
  parseVSCodeToPiMessage,
  PROTOCOL_VERSION,
  type ConnectMessage,
  type ConnectedMessage,
  type ErrorMessage,
  type PlanPublishedMessage,
  type PrefillResultMessage,
  type ProtocolMessage,
  writeMessage,
} from "./protocol";
import type { VSCodeRegistryEntry } from "./registry";

export interface PiConnectionInfo {
  instanceId: string;
  displayName: string;
  socketPath: string;
}

export interface PrefillHandlerResult {
  ok: boolean;
  queued?: boolean;
  message?: string;
}

type PrefillHandler = (text: string) => Promise<PrefillHandlerResult> | PrefillHandlerResult;
type CloseHandler = () => void;
type ErrorHandler = (message: string) => void;

export class VSCodeSocketClient {
  private socket?: net.Socket;
  private framer = new NdjsonFramer();
  private connectionInfo?: PiConnectionInfo;
  private manualClose = false;
  private pendingConnect?: {
    resolve: (message: ConnectedMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  };
  private pendingPlanPublish?: {
    resolve: (message: PlanPublishedMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  };

  constructor(
    private readonly onPrefill: PrefillHandler,
    private readonly onClose: CloseHandler,
    private readonly onErrorMessage: ErrorHandler,
  ) {}

  get isConnected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && this.connectionInfo);
  }

  get info(): PiConnectionInfo | undefined {
    return this.connectionInfo;
  }

  async connect(entry: VSCodeRegistryEntry, payload: Omit<ConnectMessage, "type" | "protocolVersion" | "token">): Promise<PiConnectionInfo> {
    this.dispose(true);
    this.manualClose = false;
    this.framer = new NdjsonFramer();

    const socket = net.createConnection(entry.socketPath);
    this.socket = socket;

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("error", (error) => this.handleSocketError(error));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to VS Code.")), 3_000);
      socket.once("connect", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    const connected = await new Promise<ConnectedMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingConnect = undefined;
        reject(new Error("Timed out waiting for VS Code to accept the connection."));
      }, 5_000);
      this.pendingConnect = { resolve, reject, timeout };

      this.write({
        type: "connect",
        protocolVersion: PROTOCOL_VERSION,
        token: entry.authToken,
        ...payload,
      });
    });

    this.connectionInfo = {
      instanceId: connected.instanceId,
      displayName: connected.displayName,
      socketPath: entry.socketPath,
    };
    return this.connectionInfo;
  }

  async publishPlan(title: string, markdown: string, planId?: string): Promise<PlanPublishedMessage> {
    if (!this.isConnected) {
      throw new Error("VS Code is not connected. Run /vscode-connect first.");
    }
    if (this.pendingPlanPublish) {
      throw new Error("A plan is already being published to VS Code.");
    }

    return new Promise<PlanPublishedMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingPlanPublish = undefined;
        reject(new Error("Timed out waiting for VS Code to publish the plan."));
      }, 30_000);

      this.pendingPlanPublish = { resolve, reject, timeout };

      try {
        this.write({ type: "publishPlan", title, markdown, planId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingPlanPublish = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  disconnect(): void {
    if (!this.socket || this.socket.destroyed) return;
    this.manualClose = true;
    this.write({ type: "disconnect" });
    this.socket.end();
    this.socket.destroySoon?.();
    this.connectionInfo = undefined;
  }

  dispose(manual = false): void {
    this.manualClose = manual;
    this.rejectPendingConnect(new Error("Connection closed."));
    this.rejectPendingPlanPublish(new Error("Connection closed."));
    this.socket?.destroy();
    this.socket = undefined;
    this.connectionInfo = undefined;
  }

  private async handleData(chunk: Buffer | string): Promise<void> {
    try {
      for (const raw of this.framer.push(chunk)) {
        const message = parseVSCodeToPiMessage(raw);

        if (message.type === "connected") {
          this.resolvePendingConnect(message);
          continue;
        }

        if (message.type === "error") {
          const error = new Error(message.message);
          const handled = this.rejectPendingConnect(error) || this.rejectPendingPlanPublish(error);
          if (!handled) this.onErrorMessage(message.message);
          continue;
        }

        if (message.type === "planPublished") {
          this.resolvePendingPlanPublish(message);
          continue;
        }

        if (message.type === "prefill") {
          const result = await this.onPrefill(message.text);
          this.write({ type: "prefillResult", ...result });
          continue;
        }
      }
    } catch (error) {
      this.write({
        type: "prefillResult",
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleClose(): void {
    const shouldNotify = Boolean(this.connectionInfo) && !this.manualClose;
    this.rejectPendingConnect(new Error("VS Code socket closed."));
    this.rejectPendingPlanPublish(new Error("VS Code socket closed."));
    this.socket = undefined;
    this.connectionInfo = undefined;
    if (shouldNotify) this.onClose();
  }

  private handleSocketError(error: Error): void {
    this.rejectPendingConnect(error);
  }

  private resolvePendingConnect(message: ConnectedMessage): void {
    const pending = this.pendingConnect;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingConnect = undefined;
    pending.resolve(message);
  }

  private rejectPendingConnect(error: Error): boolean {
    const pending = this.pendingConnect;
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pendingConnect = undefined;
    pending.reject(error);
    return true;
  }

  private resolvePendingPlanPublish(message: PlanPublishedMessage): void {
    const pending = this.pendingPlanPublish;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingPlanPublish = undefined;
    pending.resolve(message);
  }

  private rejectPendingPlanPublish(error: Error): boolean {
    const pending = this.pendingPlanPublish;
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pendingPlanPublish = undefined;
    pending.reject(error);
    return true;
  }

  private write(message: ProtocolMessage | PrefillResultMessage): void {
    if (!this.socket || this.socket.destroyed) throw new Error("VS Code socket is not connected.");
    writeMessage(this.socket, message as ProtocolMessage);
  }
}
