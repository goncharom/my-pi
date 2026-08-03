import type { ProtocolMessage } from "./messages";

export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

export class MessageTooLargeError extends Error {
  constructor() {
    super(`Protocol message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    this.name = "MessageTooLargeError";
  }
}

export class NdjsonFramer {
  private buffer = "";

  push(chunk: Buffer | string): unknown[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    if (Buffer.byteLength(this.buffer, "utf8") > MAX_MESSAGE_BYTES && !this.buffer.includes("\n")) {
      throw new MessageTooLargeError();
    }

    const messages: unknown[] = [];

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
        throw new MessageTooLargeError();
      }

      if (line.trim() === "") continue;
      messages.push(JSON.parse(line));
    }

    return messages;
  }
}

export function encodeMessage(message: ProtocolMessage): string {
  const encoded = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_MESSAGE_BYTES) {
    throw new MessageTooLargeError();
  }
  return encoded;
}

export function writeMessage(socket: NodeJS.WritableStream, message: ProtocolMessage): void {
  socket.write(encodeMessage(message), "utf8");
}
