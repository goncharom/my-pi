# Pi BTW

Fork the current Pi conversation into a floating Zellij pane without interrupting the agent working in the original pane.

## Install

```bash
pi install ./packages/extensions/pi-btw
```

## Use

Run:

```text
/btw
```

The fork opens immediately in the same directory, using the current model and thinking level. If the original agent is mid-response, the fork branches from the latest user message so it never inherits a partial tool turn.

Pi must be running inside Zellij.
