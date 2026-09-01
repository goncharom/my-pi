import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const MAX_ROWS = 14;

export interface CronJobView {
  id: string;
  name: string;
  schedule: string;
  cwd: string;
  enabled: boolean;
  taskBrief: string;
  latestSession?: string;
  latestRunAt?: string;
}

export type CronUiAction =
  | { type: "toggle"; job: CronJobView }
  | { type: "details"; job: CronJobView }
  | { type: "delete"; job: CronJobView }
  | { type: "refresh" }
  | { type: "cancel" };

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

function windowRange(selected: number, total: number): [number, number] {
  if (total <= MAX_ROWS) return [0, total];
  const start = Math.max(0, Math.min(selected - Math.floor(MAX_ROWS / 2), total - MAX_ROWS));
  return [start, start + MAX_ROWS];
}

export class CronJobsComponent {
  private selected = 0;

  constructor(
    private readonly jobs: CronJobView[],
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (action: CronUiAction) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected -= 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) && this.selected < this.jobs.length - 1) {
      this.selected += 1;
      this.requestRender();
      return;
    }

    const job = this.jobs[this.selected];
    if (job && matchesKey(data, Key.space)) {
      this.done({ type: "toggle", job });
      return;
    }
    if (job && matchesKey(data, Key.enter)) {
      this.done({ type: "details", job });
      return;
    }
    if (job && (data === "d" || data === "D")) {
      this.done({ type: "delete", job });
      return;
    }
    if (data === "r" || data === "R") {
      this.done({ type: "refresh" });
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || data === "Q") {
      this.done({ type: "cancel" });
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines = [
      fit(t.fg("accent", t.bold("PI CRON JOBS")), width),
      fit(t.fg("dim", "Recurring headless Pi tasks managed in your user crontab."), width),
      "",
    ];
    const [start, end] = windowRange(this.selected, this.jobs.length);

    for (let index = start; index < end; index += 1) {
      const job = this.jobs[index];
      const status = job.enabled ? t.fg("success", "● enabled") : t.fg("muted", "○ disabled");
      const lastRun = job.latestRunAt
        ? t.fg("dim", `last ${new Date(job.latestRunAt).toLocaleString()}`)
        : t.fg("dim", "never run");
      lines.push(
        selectedLine(
          `  ${status}  ${t.fg("text", job.name)}  ${t.fg("accent", job.schedule)}  ${lastRun}`,
          index === this.selected,
          width,
          t,
        ),
      );
    }

    if (this.jobs.length === 0) lines.push(fit(t.fg("dim", "No Pi cron jobs yet. Ask Pi to schedule one."), width));
    lines.push("");
    lines.push(fit(t.fg("dim", "↑↓ select · space toggle · enter details · d delete · r refresh · esc close"), width));
    return panel(lines, width, t);
  }

  invalidate(): void {}
}

export class CronJobDetailsComponent {
  constructor(
    private readonly job: CronJobView,
    private readonly theme: Theme,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.ctrl("c")) ||
      data === "q" ||
      data === "Q"
    ) {
      this.done();
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const contentWidth = Math.max(1, width - 4);
    const promptLines = wrapTextWithAnsi(t.fg("text", this.job.taskBrief), contentWidth).slice(0, 16);
    const lines = [
      fit(t.fg("accent", t.bold(this.job.name)), contentWidth),
      `${t.fg("dim", "status: ")}${this.job.enabled ? t.fg("success", "enabled") : t.fg("muted", "disabled")}`,
      `${t.fg("dim", "schedule: ")}${t.fg("accent", this.job.schedule)}`,
      `${t.fg("dim", "directory: ")}${t.fg("text", this.job.cwd)}`,
      `${t.fg("dim", "latest session: ")}${t.fg("text", this.job.latestSession ?? "none")}`,
      "",
      t.fg("accent", t.bold("TASK BRIEF")),
      ...promptLines,
    ];
    if (wrapTextWithAnsi(this.job.taskBrief, contentWidth).length > promptLines.length) {
      lines.push(t.fg("dim", "… task brief truncated in this view"));
    }
    lines.push("", t.fg("dim", "enter or esc to return"));
    return panel(lines, width, t);
  }

  invalidate(): void {}
}
