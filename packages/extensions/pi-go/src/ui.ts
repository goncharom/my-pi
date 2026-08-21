import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { LaunchChoice, LaunchLocation, SessionKind } from "./types";

const MAX_ROWS = 16;

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "…");
}

function selectedLine(text: string, selected: boolean, width: number, theme: Theme): string {
  const clipped = fit(text, width);
  return selected ? theme.bg("selectedBg", clipped) : clipped;
}

function panel(lines: string[], width: number, theme: Theme): string[] {
  const panelWidth = Math.max(4, width);
  const innerWidth = Math.max(1, panelWidth - 4);
  const horizontal = "─".repeat(Math.max(0, panelWidth - 2));
  const framed = [theme.fg("borderAccent", `╭${horizontal}╮`)];
  for (const line of lines) {
    const clipped = truncateToWidth(line, innerWidth, "…");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    framed.push(`${theme.fg("borderAccent", "│")} ${clipped}${padding} ${theme.fg("borderAccent", "│")}`);
  }
  framed.push(theme.fg("borderAccent", `╰${horizontal}╯`));
  return framed;
}

function windowRange(selected: number, total: number, limit = MAX_ROWS): [number, number] {
  if (total <= limit) return [0, total];
  const start = Math.max(0, Math.min(selected - Math.floor(limit / 2), total - limit));
  return [start, start + limit];
}

interface DirectoryEntry {
  name: string;
  path: string;
}

export class DirectoryNavigatorComponent {
  private currentPath: string;
  private directories: DirectoryEntry[] = [];
  private selected = 0;
  private filter = "";
  private error?: string;

  constructor(
    initialPath: string,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (path: string | null) => void,
  ) {
    this.currentPath = resolve(initialPath);
    this.refresh();
  }

  private visibleEntries(): Array<DirectoryEntry | null> {
    const query = this.filter.toLocaleLowerCase();
    const directories = query
      ? this.directories.filter((entry) => entry.name.toLocaleLowerCase().includes(query))
      : this.directories;
    return [null, ...directories];
  }

  private refresh(): void {
    this.error = undefined;
    try {
      this.directories = readdirSync(this.currentPath, { withFileTypes: true })
        .filter((entry) => {
          if (entry.isDirectory()) return true;
          if (!entry.isSymbolicLink()) return false;
          try {
            return statSync(join(this.currentPath, entry.name)).isDirectory();
          } catch {
            return false;
          }
        })
        .map((entry) => ({ name: entry.name, path: join(this.currentPath, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      this.directories = [];
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.selected = 0;
  }

  private moveTo(path: string): void {
    this.currentPath = resolve(path);
    this.filter = "";
    this.refresh();
    this.requestRender();
  }

  handleInput(data: string): void {
    const entries = this.visibleEntries();
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected -= 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) && this.selected < entries.length - 1) {
      this.selected += 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const entry = entries[this.selected];
      if (entry === null) this.done(this.currentPath);
      else if (entry) this.moveTo(entry.path);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.moveTo(dirname(this.currentPath));
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.filter) {
        this.filter = this.filter.slice(0, -1);
        this.selected = 0;
        this.requestRender();
      } else {
        this.moveTo(dirname(this.currentPath));
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.filter) {
        this.filter = "";
        this.selected = 0;
        this.requestRender();
      } else {
        this.done(null);
      }
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.done(null);
      return;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127) {
      this.filter += data;
      this.selected = 0;
      this.requestRender();
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const entries = this.visibleEntries();
    if (this.selected >= entries.length) this.selected = Math.max(0, entries.length - 1);
    const lines = [
      fit(t.fg("accent", t.bold("GO TO DIRECTORY")), width),
      fit(t.fg("muted", this.currentPath), width),
      this.filter ? fit(`${t.fg("dim", "filter: ")}${t.fg("text", this.filter)}`, width) : "",
    ];
    const [start, end] = windowRange(this.selected, entries.length);

    for (let index = start; index < end; index += 1) {
      const entry = entries[index];
      const text = entry === null
        ? `${t.fg("success", "📍")} ${t.fg("text", "Use this directory")}`
        : `${t.fg("accent", "📁")} ${t.fg("text", entry.name)}/`;
      lines.push(selectedLine(`  ${text}`, index === this.selected, width, t));
    }

    if (this.error) lines.push(fit(t.fg("error", this.error), width));
    lines.push("");
    lines.push(fit(t.fg("dim", "type to filter · enter open/select · ← or backspace parent · esc close"), width));
    return panel(lines, width, t);
  }

  invalidate(): void {}
}

export class LaunchPickerComponent {
  private sessionKind: SessionKind;
  private location: LaunchLocation = "here";
  private selectedRow = 0;
  private readonly locations: LaunchLocation[];

  constructor(
    private readonly targetPath: string,
    private readonly canFork: boolean,
    zellijAvailable: boolean,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (choice: LaunchChoice | null) => void,
  ) {
    this.sessionKind = canFork ? "fork" : "new";
    this.locations = zellijAvailable ? ["here", "pane", "tab"] : ["here"];
  }

  private cycle<T>(values: T[], current: T, direction: -1 | 1): T {
    const index = values.indexOf(current);
    return values[(index + direction + values.length) % values.length];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
      this.selectedRow = this.selectedRow === 0 ? 1 : 0;
      this.requestRender();
      return;
    }
    const direction = matchesKey(data, Key.left) ? -1 : matchesKey(data, Key.right) ? 1 : 0;
    if (direction !== 0) {
      if (this.selectedRow === 0) {
        const kinds: SessionKind[] = this.canFork ? ["new", "fork"] : ["new"];
        this.sessionKind = this.cycle(kinds, this.sessionKind, direction);
      } else {
        this.location = this.cycle(this.locations, this.location, direction);
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done({ sessionKind: this.sessionKind, location: this.location });
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.done(null);
  }

  render(width: number): string[] {
    const t = this.theme;
    const session = this.sessionKind === "fork" ? "Fork current session" : "New session";
    const location = this.location === "here" ? "This pane" : this.location === "pane" ? "New Zellij pane" : "New Zellij tab";
    const lines = [
      fit(t.fg("accent", t.bold("OPEN WORKSPACE")), width),
      fit(t.fg("muted", this.targetPath), width),
      "",
      selectedLine(`  ${t.fg("dim", "Context")}   ${t.fg("text", `‹ ${session} ›`)}`, this.selectedRow === 0, width, t),
      selectedLine(`  ${t.fg("dim", "Open in")}   ${t.fg("text", `‹ ${location} ›`)}`, this.selectedRow === 1, width, t),
      "",
      fit(t.fg("dim", this.canFork ? "↑↓ field · ←→ change · enter open · esc cancel" : "Fork is unavailable for an ephemeral session · enter open"), width),
    ];
    return panel(lines, width, t);
  }

  invalidate(): void {}
}
