# Pi Go

A folder-only filesystem navigator for Pi.

Run `/go` to browse from the current directory, or `/go <path>` to start elsewhere. The floating overlay shows folders only—no file previews or file operations.

After selecting a directory, choose:

- **New session** or **Fork current session**
- **This pane**, **New Zellij pane**, or **New Zellij tab**

Zellij options appear only when Pi is already running inside Zellij.

## Install

```bash
pi install ./packages/extensions/pi-go
```

## Controls

- Type to filter folders
- Up/Down to select
- Enter to enter a folder or choose **Use this directory**
- Left or Backspace with an empty filter to go to the parent
- Escape to clear the filter, then close
