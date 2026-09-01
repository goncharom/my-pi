# Pi Cron

Schedule recurring headless Pi tasks with the system cron daemon, then manage them from Pi's TUI.

## Install

```bash
pi install ./packages/extensions/pi-cron
```

## Use

Ask Pi to schedule a task in natural language, for example:

```text
Run a dependency audit in this project every weekday at 9am.
```

Pi turns the request into a self-contained task brief, shows it for confirmation, and creates the cron job through the `manage_pi_cron` tool.

Run `/cron` to see the jobs managed by this extension.

## Controls

- Up/Down: select a job
- Space: enable or disable
- Enter: view the task brief and latest session
- `d`: delete
- `r`: refresh
- Escape: close

## Runs and sessions

Each run starts Pi in print mode and saves a normal Pi JSONL conversation in that job's session directory under `~/.pi/agent/pi-cron/`. The scheduled process loads normal Pi extensions, skills, and project context, except for Pi Cron itself. Cron uses the machine's local timezone.

Pi authentication must be available to the non-interactive cron process. Stored Pi credentials normally work; environment variables exported only by an interactive shell may not.

## Scope

Pi Cron only changes the marked `pi-cron` section of the current user's crontab. It does not manage unrelated cron entries.
