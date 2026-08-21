# Pi Worktrees

A focused Git worktree manager for Pi.

Run `/worktrees` to open a floating overlay that lists worktrees and their clean/dirty state. You can create a worktree from the current HEAD, safely remove a clean worktree, or open one with a fresh or forked Pi session.

Sessions can open in the current pane, a new Zellij pane, or a new Zellij tab. Zellij options appear only when available.

## Install

```bash
pi install ./packages/extensions/pi-worktrees
```

## Controls

- Up/Down to select
- Enter to open
- `n` to create
- `d` to remove
- Escape to close

The current worktree and dirty worktrees cannot be removed.
