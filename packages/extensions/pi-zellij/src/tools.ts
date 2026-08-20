import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { normalizePaneId, paneIdFor, type ZellijClient, type ZellijPane } from "./client";
import { formatToolOutput } from "./output";

const listParameters = Type.Object({
  resource: StringEnum(["panes", "tabs", "clients"] as const, {
    description: "The Zellij resource collection to inspect.",
  }),
  paneId: Type.Optional(Type.String({ description: "Filter panes or clients by stable pane ID." })),
  tabId: Type.Optional(Type.Integer({ description: "Filter panes or tabs by stable tab ID.", minimum: 0 })),
  type: Type.Optional(StringEnum(["terminal", "plugin"] as const, { description: "Filter panes by pane type." })),
  focused: Type.Optional(Type.Boolean({ description: "Filter panes by focus or tabs by active state." })),
});

const createPaneParameters = Type.Object({
  command: Type.Optional(Type.String({ description: "Executable to run. Omit to open the default shell." })),
  args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed directly to the executable.", maxItems: 256 })),
  cwd: Type.Optional(Type.String({ description: "Working directory, resolved relative to Pi's cwd. Defaults to Pi's cwd." })),
  name: Type.Optional(Type.String({ description: "Pane title." })),
  placement: Type.Optional(StringEnum(["tiled", "floating", "stacked"] as const, { description: "Pane placement. Defaults to tiled." })),
  direction: Type.Optional(StringEnum(["right", "down"] as const, { description: "Split direction for a tiled pane." })),
  tabId: Type.Optional(Type.Integer({ description: "Stable target tab ID. Omit to create in the current tab.", minimum: 0 })),
  closeOnExit: Type.Optional(Type.Boolean({ description: "Close immediately when the command exits. Defaults to false." })),
  startSuspended: Type.Optional(Type.Boolean({ description: "Wait for Enter before starting the command." })),
  borderless: Type.Optional(Type.Boolean({ description: "Whether the pane has no border." })),
  x: Type.Optional(Type.String({ description: "Floating pane x coordinate, fixed or percentage." })),
  y: Type.Optional(Type.String({ description: "Floating pane y coordinate, fixed or percentage." })),
  width: Type.Optional(Type.String({ description: "Floating pane width, fixed or percentage." })),
  height: Type.Optional(Type.String({ description: "Floating pane height, fixed or percentage." })),
  pinned: Type.Optional(Type.Boolean({ description: "Whether a floating pane remains visible when floating panes are hidden." })),
});

const createTabParameters = Type.Object({
  name: Type.Optional(Type.String({ description: "Tab name." })),
  cwd: Type.Optional(Type.String({ description: "Working directory, resolved relative to Pi's cwd. Defaults to Pi's cwd." })),
  command: Type.Optional(Type.String({ description: "Executable for the initial pane. Omit to open the default shell." })),
  args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed directly to the executable.", maxItems: 256 })),
  layout: Type.Optional(Type.String({ description: "Layout name or layout file path." })),
  layoutString: Type.Optional(Type.String({ description: "Raw KDL layout string." })),
  closeOnExit: Type.Optional(Type.Boolean({ description: "Close the initial command pane when its command exits." })),
  startSuspended: Type.Optional(Type.Boolean({ description: "Wait for Enter before starting the initial command." })),
});

const readPaneParameters = Type.Object({
  paneId: Type.String({ description: "Pane ID such as terminal_17 or plugin_2." }),
  fullScrollback: Type.Optional(Type.Boolean({ description: "Include full scrollback instead of only the viewport." })),
  ansi: Type.Optional(Type.Boolean({ description: "Preserve ANSI styling. Defaults to false." })),
  maxLines: Type.Optional(Type.Integer({ description: `Maximum returned lines, up to ${DEFAULT_MAX_LINES}.`, minimum: 1, maximum: DEFAULT_MAX_LINES })),
  maxBytes: Type.Optional(Type.Integer({ description: `Maximum returned bytes, up to ${formatSize(DEFAULT_MAX_BYTES)}.`, minimum: 1024, maximum: DEFAULT_MAX_BYTES })),
});

const sendParameters = Type.Object({
  paneId: Type.String({ description: "Target terminal pane ID." }),
  action: StringEnum(["paste", "keys"] as const, { description: "Paste text or send named key events." }),
  text: Type.Optional(Type.String({ description: "Text for the paste action." })),
  keys: Type.Optional(Type.Array(Type.String(), { description: "Key names for the keys action, eg. ['Ctrl c'] or ['Enter'].", minItems: 1, maxItems: 64 })),
});

const paneActionParameters = Type.Object({
  paneId: Type.String({ description: "Target pane ID." }),
  action: StringEnum([
    "focus",
    "close",
    "clear",
    "rename",
    "resize",
    "move",
    "toggle_floating",
    "toggle_fullscreen",
    "toggle_pinned",
    "set_borderless",
    "set_floating_coordinates",
  ] as const),
  name: Type.Optional(Type.String({ description: "New name for rename." })),
  direction: Type.Optional(StringEnum(["left", "right", "up", "down", "+", "-"] as const, { description: "Direction for move or resize." })),
  enabled: Type.Optional(Type.Boolean({ description: "Desired state for set_borderless." })),
  x: Type.Optional(Type.String({ description: "Floating pane x coordinate." })),
  y: Type.Optional(Type.String({ description: "Floating pane y coordinate." })),
  width: Type.Optional(Type.String({ description: "Floating pane width." })),
  height: Type.Optional(Type.String({ description: "Floating pane height." })),
  pinned: Type.Optional(Type.Boolean({ description: "Pinned state when changing floating coordinates." })),
  borderless: Type.Optional(Type.Boolean({ description: "Borderless state when changing floating coordinates." })),
});

const tabActionParameters = Type.Object({
  tabId: Type.Integer({ description: "Stable tab ID.", minimum: 0 }),
  action: StringEnum(["focus", "close", "rename", "move", "show_floating", "hide_floating", "toggle_floating"] as const),
  name: Type.Optional(Type.String({ description: "New name for rename." })),
  direction: Type.Optional(StringEnum(["left", "right"] as const, { description: "Direction for move." })),
});

interface TabActionDetails {
  tabId: number;
  action: "focus" | "close" | "rename" | "move" | "show_floating" | "hide_floating" | "toggle_floating";
  changed?: boolean;
  floatingPanesVisible?: boolean;
  floatingPaneCount?: number;
}

const waitParameters = Type.Object({
  paneId: Type.String({ description: "Pane to observe." }),
  condition: StringEnum(["exit", "output"] as const, { description: "Wait for process exit or matching rendered output." }),
  pattern: Type.Optional(Type.String({ description: "Required when waiting for output." })),
  match: Type.Optional(StringEnum(["contains", "regex"] as const, { description: "Output matching mode. Defaults to contains." })),
  caseSensitive: Type.Optional(Type.Boolean({ description: "Whether output matching is case-sensitive. Defaults to true." })),
  fullScrollback: Type.Optional(Type.Boolean({ description: "Search full scrollback instead of only the viewport." })),
  timeoutSeconds: Type.Optional(Type.Integer({ description: "Maximum wait time. Defaults to 60 seconds.", minimum: 1, maximum: 3600 })),
});

export function registerZellijTools(pi: ExtensionAPI, client: ZellijClient): void {
  pi.registerTool({
    name: "zellij_list",
    label: "List Zellij Resources",
    description: "List and optionally filter panes, tabs, or connected clients in Pi's current Zellij session using structured session data.",
    promptSnippet: "Inspect panes, tabs, and clients in Pi's current Zellij session",
    parameters: listParameters,
    async execute(_id, params, signal) {
      validateListFilters(params);
      let data: unknown[];
      let totalCount: number;

      if (params.resource === "panes") {
        const panes = await client.listPanes(signal);
        totalCount = panes.length;
        data = panes.filter((pane) => {
          if (params.paneId && paneIdFor(pane) !== normalizePaneId(params.paneId)) return false;
          if (params.tabId !== undefined && pane.tab_id !== params.tabId) return false;
          if (params.type && (pane.is_plugin ? "plugin" : "terminal") !== params.type) return false;
          return params.focused === undefined || pane.is_focused === params.focused;
        });
      } else if (params.resource === "tabs") {
        const tabs = await client.listTabs(signal);
        totalCount = tabs.length;
        data = tabs.filter((tab) => {
          if (params.tabId !== undefined && tab.tab_id !== params.tabId) return false;
          return params.focused === undefined || tab.active === params.focused;
        });
      } else {
        const clients = await client.listClients(signal);
        totalCount = clients.length;
        data = clients.filter((connectedClient) => !params.paneId || normalizePaneId(connectedClient.paneId) === normalizePaneId(params.paneId));
      }

      const formatted = await formatToolOutput(JSON.stringify(data, null, 2), `zellij-${params.resource}`);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: { resource: params.resource, count: data.length, totalCount, filtered: data.length !== totalCount, data, fullOutputPath: formatted.fullOutputPath },
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("zellij list "))}${theme.fg("accent", args.resource)}`, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as { resource?: string; count?: number } | undefined;
      let text = theme.fg("success", `${details?.count ?? 0} ${details?.resource ?? "resources"}`);
      if (expanded && result.content[0]?.type === "text") text += `\n${theme.fg("dim", result.content[0].text)}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "zellij_create_pane",
    label: "Create Zellij Pane",
    description: "Create and verify a tiled, floating, or stacked pane in Pi's current Zellij session. Runs an executable with a direct argv array, or opens the default shell when command is omitted. Returns the stable pane ID, tab location, and current visibility.",
    promptSnippet: "Create a Zellij pane and optionally run a command in it",
    promptGuidelines: [
      "Use zellij_create_pane instead of bash when the user wants a command visibly running in a new Zellij pane.",
      "Prefer tiled placement when the user asks for an immediately visible pane. Floating panes may be hidden at the tab level; inspect the returned visible flag and use zellij_tab_action show_floating when needed.",
      "Pass shell syntax explicitly as command 'bash' with args ['-lc', '...']; zellij_create_pane does not implicitly invoke a shell.",
    ],
    parameters: createPaneParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.args?.length && !params.command) throw new Error("command is required when args are provided.");
      const placement = params.placement ?? "tiled";
      if (placement !== "floating" && hasFloatingGeometry(params)) {
        throw new Error("x, y, width, height, and pinned are only valid for floating panes.");
      }
      if (placement !== "tiled" && params.direction) throw new Error("direction is only valid for tiled panes.");

      const cwd = resolveCwd(ctx.cwd, params.cwd);
      const args = ["action", "new-pane", "--cwd", cwd];
      if (params.tabId !== undefined) args.push("--tab-id", String(params.tabId));
      if (params.name) args.push("--name", params.name);
      if (placement === "floating") args.push("--floating");
      if (placement === "stacked") args.push("--stacked");
      if (params.direction) args.push("--direction", params.direction);
      if (params.closeOnExit) args.push("--close-on-exit");
      if (params.startSuspended) args.push("--start-suspended");
      if (params.borderless !== undefined) args.push("--borderless", String(params.borderless));
      appendOptionalFlag(args, "--x", params.x);
      appendOptionalFlag(args, "--y", params.y);
      appendOptionalFlag(args, "--width", params.width);
      appendOptionalFlag(args, "--height", params.height);
      if (params.pinned !== undefined) args.push("--pinned", String(params.pinned));
      if (params.command) args.push("--", params.command, ...(params.args ?? []));

      const paneId = parseCreatedPaneId(await client.run(args, signal));
      const pane = await waitForPaneRegistration(client, paneId, signal);
      if (!pane && !params.closeOnExit) {
        throw new Error(`Zellij returned ${paneId}, but the pane did not appear in session state after creation.`);
      }

      const tab = pane ? await client.findTab(pane.tab_id, signal) : undefined;
      const floatingPanesVisible = tab?.are_floating_panes_visible ?? false;
      const pinned = pane?.is_pinned ?? params.pinned ?? false;
      const visible = Boolean(pane && tab?.active && (!pane.is_floating || floatingPanesVisible || pinned));
      const location = pane ? ` in tab ${pane.tab_id} (${pane.tab_name})` : "";
      const visibility = pane
        ? visible ? " and is visible" : pane.is_floating && !floatingPanesVisible ? "; floating panes are hidden in that tab" : "; its tab is not active"
        : "; it closed before state verification because closeOnExit is enabled";

      return {
        content: [{ type: "text", text: `Created ${paneId}${location}${visibility}.` }],
        details: {
          paneId,
          sessionName: client.sessionName,
          verified: Boolean(pane),
          placement,
          cwd,
          command: params.command,
          args: params.args ?? [],
          tabId: pane?.tab_id,
          tabName: pane?.tab_name,
          visible,
          floatingPanesVisible,
          pane,
        },
      };
    },
    renderCall(args, theme) {
      const command = args.command ? [args.command, ...(args.args ?? [])].join(" ") : "shell";
      const destination = args.placement ?? "tiled";
      return new Text(`${theme.fg("toolTitle", theme.bold("zellij pane "))}${theme.fg("accent", command)} ${theme.fg("muted", `→ ${destination}`)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "zellij_create_tab",
    label: "Create Zellij Tab",
    description: "Create and verify a tab in Pi's current Zellij session, optionally using a layout or running an executable in its initial pane. Returns the stable tab ID and state.",
    promptSnippet: "Create a Zellij tab with an optional command or layout",
    promptGuidelines: ["Use zellij_create_tab when the user explicitly wants a separate Zellij tab."],
    parameters: createTabParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (params.args?.length && !params.command) throw new Error("command is required when args are provided.");
      if (params.layout && params.layoutString) throw new Error("layout and layoutString are mutually exclusive.");
      if ((params.layout || params.layoutString) && params.command) throw new Error("A command cannot be combined with a tab layout.");

      const cwd = resolveCwd(ctx.cwd, params.cwd);
      const args = ["action", "new-tab", "--cwd", cwd];
      if (params.name) args.push("--name", params.name);
      if (params.layout) args.push("--layout", params.layout);
      if (params.layoutString) args.push("--layout-string", params.layoutString);
      if (params.closeOnExit) args.push("--close-on-exit");
      if (params.startSuspended) args.push("--start-suspended");
      if (params.command) args.push("--", params.command, ...(params.args ?? []));

      const tabId = parseCreatedTabId(await client.run(args, signal));
      const tab = await waitForTabRegistration(client, tabId, signal);
      if (!tab && !params.closeOnExit) {
        throw new Error(`Zellij returned tab ${tabId}, but the tab did not appear in session state after creation.`);
      }
      return {
        content: [{ type: "text", text: tab
          ? `Created tab ${tabId} (${tab.name}) in Zellij session ${client.sessionName}.`
          : `Created tab ${tabId}; it closed before state verification because closeOnExit is enabled.` }],
        details: { tabId, sessionName: client.sessionName, verified: Boolean(tab), name: tab?.name ?? params.name, cwd, command: params.command, args: params.args ?? [], tab },
      };
    },
    renderCall(args, theme) {
      const description = args.name ?? args.command ?? args.layout ?? "new tab";
      return new Text(`${theme.fg("toolTitle", theme.bold("zellij tab "))}${theme.fg("accent", description)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "zellij_read_pane",
    label: "Read Zellij Pane",
    description: `Read a pane's rendered viewport or full scrollback. Output is truncated to at most ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} and saved to a temporary file when truncated.`,
    promptSnippet: "Read rendered output or scrollback from a Zellij pane",
    parameters: readPaneParameters,
    async execute(_id, params, signal) {
      const paneId = normalizePaneId(params.paneId);
      const output = await client.readPane(paneId, { full: params.fullScrollback, ansi: params.ansi, signal });
      const formatted = await formatToolOutput(output, "zellij-pane", { maxLines: params.maxLines, maxBytes: params.maxBytes });
      return {
        content: [{ type: "text", text: formatted.text || "(pane is empty)" }],
        details: { paneId, fullScrollback: params.fullScrollback ?? false, ansi: params.ansi ?? false, truncation: formatted.truncation, fullOutputPath: formatted.fullOutputPath },
      };
    },
    renderCall(args, theme) {
      const scope = args.fullScrollback ? "full scrollback" : "viewport";
      return new Text(`${theme.fg("toolTitle", theme.bold("zellij read "))}${theme.fg("accent", args.paneId)} ${theme.fg("muted", scope)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "zellij_send",
    label: "Send to Zellij Pane",
    description: "Paste text or send named key events to a specific Zellij terminal pane. Input is sent directly to the pane as if entered by the user.",
    promptSnippet: "Paste text or send key events to a Zellij pane",
    parameters: sendParameters,
    async execute(_id, params, signal) {
      const paneId = normalizePaneId(params.paneId);
      let message: string;
      let characterCount: number | undefined;
      let keys: string[] | undefined;

      if (params.action === "paste") {
        if (params.text === undefined) throw new Error("text is required for the paste action.");
        if (params.keys !== undefined) throw new Error("keys cannot be used with the paste action.");
        await client.run(["action", "paste", "--pane-id", paneId, params.text], signal);
        characterCount = params.text.length;
        message = `Pasted ${characterCount} characters to ${paneId}.`;
      } else {
        if (!params.keys?.length) throw new Error("keys are required for the keys action.");
        if (params.text !== undefined) throw new Error("text cannot be used with the keys action.");
        await client.run(["action", "send-keys", "--pane-id", paneId, ...params.keys], signal);
        keys = params.keys;
        message = `Sent keys to ${paneId}: ${keys.join(", ")}.`;
      }

      return {
        content: [{ type: "text", text: message }],
        details: { paneId, action: params.action, characterCount, keys },
      };
    },
    renderCall(args, theme) {
      const value = args.action === "paste" ? `${args.text?.length ?? 0} chars` : (args.keys ?? []).join(", ");
      return new Text(`${theme.fg("toolTitle", theme.bold("zellij send "))}${theme.fg("accent", args.paneId)} ${theme.fg("muted", value)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "zellij_pane_action",
    label: "Control Zellij Pane",
    description: "Apply a focused pane operation by stable pane ID: focus, close, clear, rename, resize, move, toggle floating/fullscreen/pinned, or set floating geometry/border state.",
    promptSnippet: "Focus, close, rename, move, resize, or otherwise control a Zellij pane",
    parameters: paneActionParameters,
    async execute(_id, params, signal) {
      const paneId = normalizePaneId(params.paneId);
      const args = paneActionArgs(paneId, params);
      await client.run(args, signal);
      return { content: [{ type: "text", text: `Applied ${params.action} to ${paneId}.` }], details: { paneId, action: params.action } };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("zellij pane "))}${theme.fg("accent", args.action)} ${theme.fg("muted", args.paneId)}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "zellij_tab_action",
    label: "Control Zellij Tab",
    description: "Focus, close, rename, move, or control floating-pane visibility for a Zellij tab by its stable tab ID.",
    promptSnippet: "Focus, close, rename, move, or control floating panes in a Zellij tab",
    parameters: tabActionParameters,
    async execute(_id, params, signal) {
      const visibilityAction = params.action === "show_floating" || params.action === "hide_floating" || params.action === "toggle_floating";
      if (!visibilityAction) {
        const args = tabActionArgs(params);
        await client.run(args, signal);
        return {
          content: [{ type: "text", text: `Applied ${params.action} to tab ${params.tabId}.` }],
          details: { tabId: params.tabId, action: params.action } as TabActionDetails,
        };
      }

      const tab = await client.findTab(params.tabId, signal);
      if (!tab) throw new Error(`Zellij tab does not exist: ${params.tabId}`);
      const panes = await client.listPanes(signal);
      const floatingPaneCount = panes.filter((pane) => pane.tab_id === params.tabId && pane.is_floating).length;
      if (params.action === "toggle_floating" && floatingPaneCount === 0) {
        throw new Error(`Tab ${params.tabId} has no floating panes to toggle.`);
      }

      const currentlyVisible = tab.are_floating_panes_visible ?? false;
      const desiredVisible = params.action === "show_floating" ? true : params.action === "hide_floating" ? false : !currentlyVisible;
      let changed = desiredVisible !== currentlyVisible;
      if (changed) {
        try {
          await client.run(tabActionArgs(params), signal);
        } catch (error) {
          const updated = await client.findTab(params.tabId, signal);
          if (updated?.are_floating_panes_visible !== desiredVisible) throw error;
          changed = false;
        }
      }

      const updatedTab = await waitForFloatingVisibility(client, params.tabId, desiredVisible, signal);
      if (!updatedTab) throw new Error(`Tab ${params.tabId} disappeared while changing floating-pane visibility.`);
      if (updatedTab.are_floating_panes_visible !== desiredVisible) {
        throw new Error(`Floating-pane visibility for tab ${params.tabId} did not change to ${desiredVisible}.`);
      }
      const state = desiredVisible ? "visible" : "hidden";
      return {
        content: [{ type: "text", text: `Floating panes are ${state} in tab ${params.tabId}${changed ? "" : " (already in that state)"}.` }],
        details: { tabId: params.tabId, action: params.action, changed, floatingPanesVisible: desiredVisible, floatingPaneCount } as TabActionDetails,
      };
    },
    renderCall(args, theme) {
      return new Text(`${theme.fg("toolTitle", theme.bold("zellij tab "))}${theme.fg("accent", args.action)} ${theme.fg("muted", String(args.tabId))}`, 0, 0);
    },
  });

  pi.registerTool({
    name: "zellij_wait",
    label: "Wait for Zellij Pane",
    description: "Wait until a Zellij command pane exits or until its rendered output contains a string or matches a regular expression. Returns the pane's latest output when the condition is met.",
    promptSnippet: "Wait for a Zellij pane to exit or emit matching output",
    parameters: waitParameters,
    async execute(_id, params, signal) {
      const paneId = normalizePaneId(params.paneId);
      const initialPane = await client.findPane(paneId, signal);
      if (!initialPane) throw new Error(`Zellij pane does not exist: ${paneId}`);
      if (params.condition === "output" && !params.pattern) throw new Error("pattern is required when waiting for output.");

      const matcher = params.condition === "output"
        ? createMatcher(params.pattern!, params.match ?? "contains", params.caseSensitive ?? true)
        : undefined;
      const timeoutSeconds = params.timeoutSeconds ?? 60;
      const deadline = Date.now() + timeoutSeconds * 1000;
      let lastOutput = "";

      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error("Waiting for the Zellij pane was cancelled.");
        const pane = await client.findPane(paneId, signal);

        if (params.condition === "exit") {
          if (!pane || pane.exited) return waitResult(client, paneId, pane, lastOutput, params.fullScrollback, signal);
        } else {
          if (!pane) throw new Error(`Zellij pane closed before output matched: ${paneId}`);
          lastOutput = await client.readPane(paneId, { full: params.fullScrollback, signal });
          if (matcher!(lastOutput)) return waitResult(client, paneId, pane, lastOutput, params.fullScrollback, signal, params.pattern);
        }

        await abortableDelay(500, signal);
      }

      throw new Error(`Timed out after ${timeoutSeconds}s waiting for ${params.condition} in ${paneId}.`);
    },
    renderCall(args, theme) {
      const condition = args.condition === "output" ? `output ${JSON.stringify(args.pattern)}` : "exit";
      return new Text(`${theme.fg("toolTitle", theme.bold("zellij wait "))}${theme.fg("accent", args.paneId)} ${theme.fg("muted", condition)}`, 0, 0);
    },
  });
}

function validateListFilters(params: {
  resource: "panes" | "tabs" | "clients";
  paneId?: string;
  tabId?: number;
  type?: "terminal" | "plugin";
  focused?: boolean;
}): void {
  if (params.paneId) normalizePaneId(params.paneId);
  if (params.resource === "tabs" && (params.paneId !== undefined || params.type !== undefined)) {
    throw new Error("paneId and type filters are not valid when listing tabs.");
  }
  if (params.resource === "clients" && (params.tabId !== undefined || params.type !== undefined || params.focused !== undefined)) {
    throw new Error("tabId, type, and focused filters are not valid when listing clients.");
  }
}

async function waitForPaneRegistration(
  client: ZellijClient,
  paneId: string,
  signal?: AbortSignal,
): Promise<ZellijPane | undefined> {
  const deadline = Date.now() + 2_000;
  do {
    const pane = await client.findPane(paneId, signal);
    if (pane) return pane;
    await abortableDelay(100, signal);
  } while (Date.now() < deadline);
  return undefined;
}

async function waitForTabRegistration(client: ZellijClient, tabId: number, signal?: AbortSignal) {
  const deadline = Date.now() + 2_000;
  do {
    const tab = await client.findTab(tabId, signal);
    if (tab) return tab;
    await abortableDelay(100, signal);
  } while (Date.now() < deadline);
  return undefined;
}

async function waitForFloatingVisibility(
  client: ZellijClient,
  tabId: number,
  visible: boolean,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + 1_000;
  do {
    const tab = await client.findTab(tabId, signal);
    if (!tab || tab.are_floating_panes_visible === visible) return tab;
    await abortableDelay(100, signal);
  } while (Date.now() < deadline);
  return client.findTab(tabId, signal);
}

function resolveCwd(base: string, cwd: string | undefined): string {
  if (!cwd) return base;
  const normalized = cwd.startsWith("@") ? cwd.slice(1) : cwd;
  return resolve(base, normalized);
}

function appendOptionalFlag(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) args.push(flag, value);
}

function hasFloatingGeometry(params: { x?: string; y?: string; width?: string; height?: string; pinned?: boolean }): boolean {
  return params.x !== undefined || params.y !== undefined || params.width !== undefined || params.height !== undefined || params.pinned !== undefined;
}

function parseCreatedPaneId(output: string): string {
  const match = /(?:terminal|plugin)_\d+/.exec(output);
  if (!match) throw new Error(`Zellij did not return a pane ID: ${output.trim() || "(empty output)"}`);
  return match[0];
}

function parseCreatedTabId(output: string): number {
  const match = /(?:^|\n)\s*(\d+)\s*$/.exec(output);
  if (!match) throw new Error(`Zellij did not return a tab ID: ${output.trim() || "(empty output)"}`);
  return Number.parseInt(match[1], 10);
}

function paneActionArgs(
  paneId: string,
  params: {
    action: "focus" | "close" | "clear" | "rename" | "resize" | "move" | "toggle_floating" | "toggle_fullscreen" | "toggle_pinned" | "set_borderless" | "set_floating_coordinates";
    name?: string;
    direction?: "left" | "right" | "up" | "down" | "+" | "-";
    enabled?: boolean;
    x?: string;
    y?: string;
    width?: string;
    height?: string;
    pinned?: boolean;
    borderless?: boolean;
  },
): string[] {
  switch (params.action) {
    case "focus": return ["action", "focus-pane-id", paneId];
    case "close": return ["action", "close-pane", "--pane-id", paneId];
    case "clear": return ["action", "clear", "--pane-id", paneId];
    case "rename":
      if (params.name === undefined) throw new Error("name is required for rename.");
      return ["action", "rename-pane", "--pane-id", paneId, params.name];
    case "resize":
      if (!params.direction) throw new Error("direction is required for resize.");
      return ["action", "resize", "--pane-id", paneId, params.direction];
    case "move": {
      if (params.direction === "+" || params.direction === "-") throw new Error("move direction must be left, right, up, or down.");
      const args = ["action", "move-pane", "--pane-id", paneId];
      if (params.direction) args.push(params.direction);
      return args;
    }
    case "toggle_floating": return ["action", "toggle-pane-embed-or-floating", "--pane-id", paneId];
    case "toggle_fullscreen": return ["action", "toggle-fullscreen", "--pane-id", paneId];
    case "toggle_pinned": return ["action", "toggle-pane-pinned", "--pane-id", paneId];
    case "set_borderless":
      if (params.enabled === undefined) throw new Error("enabled is required for set_borderless.");
      return ["action", "set-pane-borderless", "--pane-id", paneId, "--borderless", String(params.enabled)];
    case "set_floating_coordinates": {
      if (params.x === undefined && params.y === undefined && params.width === undefined && params.height === undefined && params.pinned === undefined && params.borderless === undefined) {
        throw new Error("At least one floating coordinate or state is required.");
      }
      const args = ["action", "change-floating-pane-coordinates", "--pane-id", paneId];
      appendOptionalFlag(args, "--x", params.x);
      appendOptionalFlag(args, "--y", params.y);
      appendOptionalFlag(args, "--width", params.width);
      appendOptionalFlag(args, "--height", params.height);
      if (params.pinned !== undefined) args.push("--pinned", String(params.pinned));
      if (params.borderless !== undefined) args.push("--borderless", String(params.borderless));
      return args;
    }
  }
}

function tabActionArgs(params: {
  tabId: number;
  action: "focus" | "close" | "rename" | "move" | "show_floating" | "hide_floating" | "toggle_floating";
  name?: string;
  direction?: "left" | "right";
}): string[] {
  switch (params.action) {
    case "focus": return ["action", "go-to-tab-by-id", String(params.tabId)];
    case "close": return ["action", "close-tab-by-id", String(params.tabId)];
    case "rename":
      if (params.name === undefined) throw new Error("name is required for rename.");
      return ["action", "rename-tab-by-id", String(params.tabId), params.name];
    case "move":
      if (!params.direction) throw new Error("direction is required for move.");
      return ["action", "move-tab", params.direction, "--tab-id", String(params.tabId)];
    case "show_floating": return ["action", "show-floating-panes", "--tab-id", String(params.tabId)];
    case "hide_floating": return ["action", "hide-floating-panes", "--tab-id", String(params.tabId)];
    case "toggle_floating": return ["action", "toggle-floating-panes", "--tab-id", String(params.tabId)];
  }
}

function createMatcher(pattern: string, mode: "contains" | "regex", caseSensitive: boolean): (text: string) => boolean {
  if (mode === "contains") {
    const expected = caseSensitive ? pattern : pattern.toLowerCase();
    return (text) => (caseSensitive ? text : text.toLowerCase()).includes(expected);
  }

  let expression: RegExp;
  try {
    expression = new RegExp(pattern, caseSensitive ? "" : "i");
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  return (text) => expression.test(text);
}

async function waitResult(
  client: ZellijClient,
  paneId: string,
  pane: ZellijPane | undefined,
  knownOutput: string,
  fullScrollback: boolean | undefined,
  signal: AbortSignal | undefined,
  pattern?: string,
) {
  let output = knownOutput;
  if (!output && pane) {
    try {
      output = await client.readPane(paneId, { full: fullScrollback, signal });
    } catch {
      // The pane may close between the state query and screen capture.
    }
  }
  const formatted = await formatToolOutput(output, "zellij-wait");
  const status = pane ? (pane.exited ? `exited with status ${pane.exit_status ?? "unknown"}` : "matched output") : "closed";
  const text = [`Pane ${paneId} ${status}${pattern ? ` matching ${JSON.stringify(pattern)}` : ""}.`, formatted.text].filter(Boolean).join("\n\n");
  return {
    content: [{ type: "text" as const, text }],
    details: {
      paneId,
      matched: pattern !== undefined,
      pattern,
      closed: !pane,
      exited: pane?.exited ?? false,
      exitStatus: pane?.exit_status,
      fullOutputPath: formatted.fullOutputPath,
    },
  };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, reject) => {
    if (signal?.aborted) {
      reject(new Error("Waiting for the Zellij pane was cancelled."));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Waiting for the Zellij pane was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
