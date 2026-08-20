# Pi Zellij

Foundational tools for controlling the Zellij session that contains Pi.

The extension binds every command to `ZELLIJ_SESSION_NAME` and exposes structured primitives rather than workflow-specific commands:

- `zellij_list` — list or filter panes, tabs, or clients
- `zellij_create_pane` — create and verify a tiled, floating, or stacked pane
- `zellij_create_tab` — create and verify a tab with an optional command or layout
- `zellij_read_pane` — read a viewport or full scrollback
- `zellij_send` — paste text or send key events
- `zellij_pane_action` — focus, close, rename, move, resize, and change pane state
- `zellij_tab_action` — focus, close, rename, move, or control floating-pane visibility in a tab
- `zellij_wait` — wait for pane exit or matching output

Commands use a direct executable and argument array. Invoke a shell explicitly when shell syntax is needed:

```json
{
  "command": "bash",
  "args": ["-lc", "pnpm test | tee test.log"]
}
```

Relative working directories are resolved from Pi's current working directory. Pane and tab creation is verified against Zellij's structured state before success is reported, and results include stable IDs and location information for subsequent calls.

## Visibility and discovery

Tiled panes are the best default when a user asks for an immediately visible command. Floating panes can exist while a tab's floating layer is hidden. `zellij_create_pane` reports the target tab, whether the pane is currently visible, and whether that tab's floating panes are visible. Use `zellij_tab_action` with `show_floating`, `hide_floating`, or `toggle_floating` to control that layer.

`zellij_list` accepts resource-specific filters. Panes can be filtered by `paneId`, `tabId`, `type`, and `focused`; tabs by `tabId` and `focused`; clients by `paneId`.

Zellij CLI calls are serialized within the extension. Read-only state calls are retried once for transient session or connection failures.
