import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ZellijClient } from "./src/client";
import { registerZellijTools } from "./src/tools";

export default function zellijExtension(pi: ExtensionAPI): void {
  const client = new ZellijClient((command, args, options) => pi.exec(command, args, options));
  registerZellijTools(pi, client);
}
