import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { LaunchChoice, LaunchLocation, SessionKind, WorktreeAction, WorktreeInfo } from "./types";

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

export class WorktreeListComponent {
  private selected = 0;

  constructor(
    private readonly worktrees: WorktreeInfo[],
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (action: WorktreeAction) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected -= 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) && this.selected < this.worktrees.length - 1) {
      this.selected += 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) && this.worktrees[this.selected]) {
      this.done({ type: "open", worktree: this.worktrees[this.selected] });
      return;
    }
    if (data === "n" || data === "N") {
      this.done({ type: "create" });
      return;
    }
    if ((data === "d" || data === "D") && this.worktrees[this.selected]) {
      this.done({ type: "delete", worktree: this.worktrees[this.selected] });
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || data === "Q") {
      this.done({ type: "cancel" });
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines = [
      fit(t.fg("accent", t.bold("GIT WORKTREES")), width),
      fit(t.fg("dim", "Choose a worktree, create one, or remove a clean worktree."), width),
      "",
    ];
    const [start, end] = windowRange(this.selected, this.worktrees.length);

    for (let index = start; index < end; index += 1) {
      const worktree = this.worktrees[index];
      const marker = worktree.current ? t.fg("accent", "●") : " ";
      const branch = worktree.branch ?? (worktree.detached ? "detached" : "unknown");
      const state = worktree.prunable
        ? t.fg("warning", "prunable")
        : worktree.dirty
          ? t.fg("warning", "dirty")
          : t.fg("success", "clean");
      const current = worktree.current ? ` ${t.fg("accent", "current")}` : "";
      lines.push(selectedLine(`${marker} ${t.fg("text", branch)}  ${t.fg("muted", worktree.path)}  ${state}${current}`, index === this.selected, width, t));
    }

    if (this.worktrees.length === 0) lines.push(fit(t.fg("dim", "No worktrees found."), width));
    lines.push("");
    lines.push(fit(t.fg("dim", "↑↓ select · enter open · n create · d remove · esc close"), width));
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
      fit(t.fg("accent", t.bold("OPEN WORKTREE")), width),
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
