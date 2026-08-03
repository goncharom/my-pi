import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { VSCodeSocketClient } from "./socket-client";

let latestPlanId: string | undefined;

export function registerPublishPlanTool(pi: ExtensionAPI, client: VSCodeSocketClient): void {
  pi.registerTool({
    name: "vscode_publish_plan",
    label: "Publish Plan to VS Code",
    description: "Publish an implementation plan to the connected VS Code window for user review.",
    promptSnippet: "Publish an implementation plan to the connected VS Code window for user review.",
    promptGuidelines: [
      "Use vscode_publish_plan when the user asks for an implementation plan; publish the completed plan for review.",
      "When revising a previously published plan, pass the same planId so VS Code stores a new version.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Short title for the plan." }),
      markdown: Type.String({ description: "The complete plan as Markdown." }),
      planId: Type.Optional(Type.String({ description: "Existing plan ID when publishing a revision." })),
    }),
    async execute(_toolCallId, params) {
      if (!client.isConnected) {
        throw new Error("VS Code is not connected. Run /vscode-connect first.");
      }

      const published = await client.publishPlan(params.title, params.markdown, params.planId);
      latestPlanId = published.planId;

      return {
        content: [
          {
            type: "text" as const,
            text: `Published plan to VS Code: planId=${published.planId}, version=${published.version}, uri=${published.uri}`,
          },
        ],
        details: published,
      };
    },
  });
}
