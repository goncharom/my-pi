import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  CronJobDetailsComponent,
  CronJobsComponent,
  type CronJobView,
  type CronUiAction,
} from "./ui";

const BEGIN_MARKER = "# BEGIN pi-cron managed jobs";
const END_MARKER = "# END pi-cron managed jobs";
const PROMPT_FOOTER = `This is an unattended scheduled Pi run. Work independently using the task brief above.
The pi-cron extension is disabled for this run, so scheduled jobs cannot be created or changed from this process.`;

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  cwd: string;
  taskBrief: string;
  enabled: boolean;
  piPath: string;
  provider?: string;
  model?: string;
  thinking?: string;
  createdAt: string;
  updatedAt: string;
}

interface CronState {
  version: 1;
  jobs: CronJob[];
}

interface CronPaths {
  root: string;
  state: string;
  prompts: string;
  sessions: string;
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function cronPaths(): CronPaths {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const configRoot = configured
    ? resolve(configured)
    : join(homedir(), ".pi", "agent");
  const root = join(configRoot, "pi-cron");
  return {
    root,
    state: join(root, "jobs.json"),
    prompts: join(root, "prompts"),
    sessions: join(root, "sessions"),
  };
}

function promptPath(paths: CronPaths, id: string): string {
  return join(paths.prompts, `${id}.md`);
}

function sessionDir(paths: CronPaths, id: string): string {
  return join(paths.sessions, id);
}

async function ensureDirectories(paths: CronPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.root, { recursive: true }),
    mkdir(paths.prompts, { recursive: true }),
    mkdir(paths.sessions, { recursive: true }),
  ]);
}

async function loadState(paths: CronPaths): Promise<CronState> {
  try {
    const parsed = JSON.parse(await readFile(paths.state, "utf8")) as CronState;
    return {
      version: 1,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [] };
    throw error;
  }
}

async function saveState(paths: CronPaths, jobs: CronJob[]): Promise<void> {
  await ensureDirectories(paths);
  await writeFile(paths.state, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function validateSchedule(schedule: string): string {
  const normalized = schedule.trim().replace(/\s+/g, " ");
  if (/[\r\n]/.test(schedule)) throw new Error("Cron schedule cannot contain a newline.");
  const fields = normalized.split(" ");
  if (fields.length !== 5 || fields.some((field) => !/^[A-Za-z0-9*/,\-]+$/.test(field))) {
    throw new Error("Cron schedule must be a standard five-field expression, such as '0 9 * * 1-5'.");
  }
  return normalized;
}

function validateName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error("Job name cannot be empty.");
  if (/[\r\n]/.test(normalized)) throw new Error("Job name cannot contain a newline.");
  return normalized;
}

function validateTaskBrief(taskBrief: string): string {
  const normalized = taskBrief.trim();
  if (!normalized) throw new Error("Task brief cannot be empty.");
  return normalized;
}

async function validateCwd(value: string, base: string): Promise<string> {
  const cwd = isAbsolute(value) ? resolve(value) : resolve(base, value);
  if (/[\r\n]/.test(cwd)) throw new Error("Working directory cannot contain a newline.");
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);
  return cwd;
}

async function findPiExecutable(): Promise<string> {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, process.platform === "win32" ? "pi.cmd" : "pi");
    try {
      await access(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {}
  }
  throw new Error("Could not find the pi executable in PATH.");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function promptContents(taskBrief: string): string {
  return `${taskBrief.trim()}\n\n---\n\n${PROMPT_FOOTER}\n`;
}

async function writePrompt(paths: CronPaths, job: CronJob): Promise<void> {
  await ensureDirectories(paths);
  await writeFile(promptPath(paths, job.id), promptContents(job.taskBrief), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function cronCommand(paths: CronPaths, job: CronJob): string {
  const args = [
    shellQuote(job.piPath),
    "--print",
    "--session-dir",
    shellQuote(sessionDir(paths, job.id)),
    "--name",
    shellQuote(`cron: ${job.name}`),
  ];
  if (job.provider) args.push("--provider", shellQuote(job.provider));
  if (job.model) args.push("--model", shellQuote(job.model));
  if (job.thinking) args.push("--thinking", shellQuote(job.thinking));
  args.push(shellQuote(`@${promptPath(paths, job.id)}`));

  const command = `${job.schedule} cd ${shellQuote(job.cwd)} && PI_CRON_CHILD=1 PI_CODING_AGENT_DIR=${shellQuote(dirname(paths.root))} ${args.join(" ")} >/dev/null 2>&1 # pi-cron:${job.id}`;
  return command.replace(/%/g, "\\%");
}

function findMarkerLine(text: string, marker: string, from = 0): { start: number; end: number } | undefined {
  let index = text.indexOf(marker, from);
  while (index >= 0) {
    const atLineStart = index === 0 || text[index - 1] === "\n";
    const after = index + marker.length;
    const atLineEnd = after === text.length || text[after] === "\n" || (text[after] === "\r" && text[after + 1] === "\n");
    if (atLineStart && atLineEnd) {
      let end = after;
      if (text[end] === "\r") end += 1;
      if (text[end] === "\n") end += 1;
      return { start: index, end };
    }
    index = text.indexOf(marker, index + marker.length);
  }
  return undefined;
}

function renderCrontab(current: string, paths: CronPaths, jobs: CronJob[]): string {
  const start = findMarkerLine(current, BEGIN_MARKER);
  const end = start ? findMarkerLine(current, END_MARKER, start.end) : undefined;
  if (start && !end) throw new Error(`Found '${BEGIN_MARKER}' without a matching end marker.`);
  if (!start && findMarkerLine(current, END_MARKER)) {
    throw new Error(`Found '${END_MARKER}' without a matching begin marker.`);
  }

  const enabled = jobs.filter((job) => job.enabled);
  const block = enabled.length > 0
    ? `${BEGIN_MARKER}\n${enabled.map((job) => cronCommand(paths, job)).join("\n")}\n${END_MARKER}\n`
    : "";

  if (start && end) return `${current.slice(0, start.start)}${block}${current.slice(end.end)}`;
  if (!block) return current;
  const separator = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${block}`;
}

function runProcess(command: string, args: string[], input?: string): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

function crontabExecutable(): string {
  return process.env.PI_CRON_CRONTAB_BIN?.trim() || "crontab";
}

async function readCrontab(): Promise<string> {
  const result = await runProcess(crontabExecutable(), ["-l"]);
  if (result.code === 0) return result.stdout;
  if (result.code === 1 && /no crontab/i.test(result.stderr)) return "";
  throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not read the user crontab.");
}

async function installJobs(paths: CronPaths, jobs: CronJob[]): Promise<void> {
  const next = renderCrontab(await readCrontab(), paths, jobs);
  const result = await runProcess(crontabExecutable(), ["-"], next);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Could not install the user crontab.");
  }
}

async function latestJsonl(directory: string): Promise<{ path: string; mtime: Date } | undefined> {
  if (!existsSync(directory)) return undefined;
  let latest: { path: string; mtime: Date } | undefined;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await latestJsonl(path);
      if (nested && (!latest || nested.mtime > latest.mtime)) latest = nested;
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const info = await stat(path);
      if (!latest || info.mtime > latest.mtime) latest = { path, mtime: info.mtime };
    }
  }
  return latest;
}

async function jobViews(paths: CronPaths, jobs: CronJob[]): Promise<CronJobView[]> {
  return Promise.all(jobs.map(async (job) => {
    const latest = await latestJsonl(sessionDir(paths, job.id));
    return {
      id: job.id,
      name: job.name,
      schedule: job.schedule,
      cwd: job.cwd,
      enabled: job.enabled,
      taskBrief: job.taskBrief,
      latestSession: latest?.path,
      latestRunAt: latest?.mtime.toISOString(),
    };
  }));
}

function requireJob(jobs: CronJob[], id: string | undefined): CronJob {
  if (!id) throw new Error("A job id is required for this action.");
  const job = jobs.find((candidate) => candidate.id === id);
  if (!job) throw new Error(`No Pi cron job found with id '${id}'.`);
  return job;
}

async function setEnabled(paths: CronPaths, id: string, enabled: boolean): Promise<CronJob> {
  const state = await loadState(paths);
  const current = requireJob(state.jobs, id);
  const updated = { ...current, enabled, updatedAt: new Date().toISOString() };
  const jobs = state.jobs.map((job) => job.id === id ? updated : job);
  await installJobs(paths, jobs);
  await saveState(paths, jobs);
  return updated;
}

async function deleteJob(paths: CronPaths, id: string): Promise<CronJob> {
  const state = await loadState(paths);
  const current = requireJob(state.jobs, id);
  const jobs = state.jobs.filter((job) => job.id !== id);
  await installJobs(paths, jobs);
  await saveState(paths, jobs);
  await Promise.all([
    rm(promptPath(paths, id), { force: true }),
    rm(sessionDir(paths, id), { recursive: true, force: true }),
  ]);
  return current;
}

function formatJobs(views: CronJobView[]): string {
  if (views.length === 0) return "No Pi cron jobs are configured.";
  return views.map((job) => [
    `${job.enabled ? "enabled" : "disabled"}  ${job.name} (${job.id})`,
    `  schedule: ${job.schedule}`,
    `  cwd: ${job.cwd}`,
    `  latest session: ${job.latestSession ?? "none"}`,
  ].join("\n")).join("\n\n");
}

async function chooseJobAction(ctx: ExtensionCommandContext, jobs: CronJobView[]): Promise<CronUiAction> {
  return ctx.ui.custom<CronUiAction>(
    (tui, theme, _keybindings, done) =>
      new CronJobsComponent(jobs, theme, () => tui.requestRender(), done),
    {
      overlay: true,
      overlayOptions: {
        width: "82%",
        minWidth: 62,
        maxHeight: "82%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

async function showJobDetails(ctx: ExtensionCommandContext, job: CronJobView): Promise<void> {
  await ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) => new CronJobDetailsComponent(job, theme, done),
    {
      overlay: true,
      overlayOptions: {
        width: "82%",
        minWidth: 62,
        maxHeight: "86%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

async function runCronUi(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/cron requires Pi's interactive TUI.", "error");
    return;
  }
  const paths = cronPaths();

  while (true) {
    try {
      const state = await loadState(paths);
      const action = await chooseJobAction(ctx, await jobViews(paths, state.jobs));
      if (action.type === "cancel") return;
      if (action.type === "refresh") continue;
      if (action.type === "details") {
        await showJobDetails(ctx, action.job);
        continue;
      }
      if (action.type === "toggle") {
        const updated = await setEnabled(paths, action.job.id, !action.job.enabled);
        ctx.ui.notify(`${updated.name} ${updated.enabled ? "enabled" : "disabled"}.`, "info");
        continue;
      }
      const confirmed = await ctx.ui.confirm(
        "Delete Pi cron job?",
        `${action.job.name}\n${action.job.schedule}\n\nIts saved Pi sessions will also be deleted.`,
      );
      if (!confirmed) continue;
      await deleteJob(paths, action.job.id);
      ctx.ui.notify(`Deleted ${action.job.name}.`, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
  }
}

export default function cronExtension(pi: ExtensionAPI): void {
  if (process.env.PI_CRON_CHILD === "1") return;

  pi.registerCommand("cron", {
    description: "Manage recurring headless Pi jobs",
    handler: async (_args, ctx) => runCronUi(ctx),
  });

  pi.registerTool({
    name: "manage_pi_cron",
    label: "Manage Pi Cron",
    description: "List, create, update, enable, disable, or delete recurring cron jobs that run Pi headlessly. For create and update, taskBrief must be a complete standalone prompt for a fresh Pi process with no access to the current conversation. Include the objective, relevant project context, constraints, allowed changes, verification steps, and expected final report. Ask the user for missing details before scheduling. Use a standard five-field cron expression in the machine's local timezone.",
    promptSnippet: "Manage recurring cron jobs that invoke Pi with self-contained task briefs",
    promptGuidelines: [
      "Use manage_pi_cron only when the user explicitly asks to schedule or manage a recurring Pi task.",
      "When creating or updating a manage_pi_cron job, write a self-contained taskBrief with all relevant context from the conversation; do not merely copy the user's short scheduling request.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "create", "update", "enable", "disable", "delete"] as const),
      id: Type.Optional(Type.String({ description: "Job id for update, enable, disable, or delete" })),
      name: Type.Optional(Type.String({ description: "Short descriptive job name" })),
      schedule: Type.Optional(Type.String({ description: "Standard five-field cron expression in the host timezone" })),
      taskBrief: Type.Optional(Type.String({ description: "Detailed standalone prompt with enough context for a fresh unattended Pi process" })),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the current Pi directory" })),
      provider: Type.Optional(Type.String({ description: "Pi provider; defaults to the current provider" })),
      model: Type.Optional(Type.String({ description: "Pi model id; defaults to the current model" })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = cronPaths();
      const state = await loadState(paths);

      if (params.action === "list") {
        const views = await jobViews(paths, state.jobs);
        return { content: [{ type: "text", text: formatJobs(views) }], details: { jobs: views } };
      }

      if (params.action === "enable" || params.action === "disable") {
        const updated = await setEnabled(paths, params.id ?? "", params.action === "enable");
        return {
          content: [{ type: "text", text: `${updated.name} is now ${updated.enabled ? "enabled" : "disabled"}.` }],
          details: { job: updated },
        };
      }

      if (params.action === "delete") {
        const job = requireJob(state.jobs, params.id);
        if (ctx.mode === "tui") {
          const confirmed = await ctx.ui.confirm(
            "Delete Pi cron job?",
            `${job.name}\n${job.schedule}\n\nIts saved Pi sessions will also be deleted.`,
          );
          if (!confirmed) return { content: [{ type: "text", text: "Deletion cancelled." }], details: { cancelled: true } };
        }
        await deleteJob(paths, job.id);
        return { content: [{ type: "text", text: `Deleted ${job.name}.` }], details: { job } };
      }

      if (params.action === "create") {
        const now = new Date().toISOString();
        const job: CronJob = {
          id: randomUUID(),
          name: validateName(params.name ?? ""),
          schedule: validateSchedule(params.schedule ?? ""),
          cwd: await validateCwd(params.cwd?.trim() || ctx.cwd, ctx.cwd),
          taskBrief: validateTaskBrief(params.taskBrief ?? ""),
          enabled: true,
          piPath: await findPiExecutable(),
          provider: params.provider?.trim() || ctx.model?.provider,
          model: params.model?.trim() || ctx.model?.id,
          thinking: params.thinking ?? ctx.thinkingLevel,
          createdAt: now,
          updatedAt: now,
        };
        if (ctx.mode === "tui") {
          const confirmed = await ctx.ui.confirm(
            "Schedule recurring Pi job?",
            `${job.name}\n${job.schedule} (host timezone)\n${job.cwd}\n\n${job.taskBrief}`,
          );
          if (!confirmed) return { content: [{ type: "text", text: "Scheduling cancelled." }], details: { cancelled: true } };
        }
        const jobs = [...state.jobs, job];
        await writePrompt(paths, job);
        await installJobs(paths, jobs);
        await saveState(paths, jobs);
        return {
          content: [{ type: "text", text: `Scheduled ${job.name} (${job.id}) for '${job.schedule}' in the host timezone.` }],
          details: { job },
        };
      }

      const current = requireJob(state.jobs, params.id);
      const updated: CronJob = {
        ...current,
        name: params.name === undefined ? current.name : validateName(params.name),
        schedule: params.schedule === undefined ? current.schedule : validateSchedule(params.schedule),
        cwd: params.cwd === undefined ? current.cwd : await validateCwd(params.cwd, ctx.cwd),
        taskBrief: params.taskBrief === undefined ? current.taskBrief : validateTaskBrief(params.taskBrief),
        provider: params.provider === undefined ? current.provider : params.provider.trim() || undefined,
        model: params.model === undefined ? current.model : params.model.trim() || undefined,
        thinking: params.thinking ?? current.thinking,
        updatedAt: new Date().toISOString(),
      };
      if (ctx.mode === "tui") {
        const confirmed = await ctx.ui.confirm(
          "Update recurring Pi job?",
          `${updated.name}\n${updated.schedule} (host timezone)\n${updated.cwd}\n\n${updated.taskBrief}`,
        );
        if (!confirmed) return { content: [{ type: "text", text: "Update cancelled." }], details: { cancelled: true } };
      }
      const jobs = state.jobs.map((job) => job.id === updated.id ? updated : job);
      await writePrompt(paths, updated);
      await installJobs(paths, jobs);
      await saveState(paths, jobs);
      return {
        content: [{ type: "text", text: `Updated ${updated.name} (${updated.id}).` }],
        details: { job: updated },
      };
    },
  });
}
