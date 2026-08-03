---
name: browser-cdp
description: Opens, inspects, interacts with, screenshots, and verifies browser applications through an isolated headless Chrome instance using the Chrome DevTools Protocol (CDP). Use for local apps and user-authorized webpages.
---

# Browser Automation with CDP

Use this skill to inspect and interact with browser applications through Chrome DevTools Protocol (CDP). It provides a dependency-free Node helper at [scripts/cdp.mjs](scripts/cdp.mjs).

## Safety rules

- Local URLs are allowed by default. For a remote `http(s)` URL, use `--allow-remote` only after the user explicitly asks to visit that target.
- Do not browse, crawl, or follow arbitrary external links beyond the user's requested scope.
- Do not expose CDP to the network. The helper binds Chrome's debugging endpoint to `127.0.0.1` and uses an isolated temporary browser profile.
- Never use a person's existing Chrome profile. It may contain active sessions, cookies, or credentials.
- Do not retrieve, log, or inspect cookies, passwords, local storage, or other secrets unless the user explicitly asks and owns the target.
- Clean up Chrome with `close` when the inspection is complete, including after failures.
- A screenshot can contain sensitive information. Store it under `/tmp` unless the user requests a durable project asset.

## Preconditions

1. Confirm the Chrome executable exists. For a local app, also confirm the server and route:

```bash
command -v google-chrome || command -v chromium || command -v chromium-browser
curl -I http://127.0.0.1:<port>/<path>
```

2. If a local server exposes a directory listing, identify the application path before opening Chrome. For example, a server running at a repository root may serve an app at:

```text
http://127.0.0.1:8000/presentation/
```

Do not start an application server unless the user asks, or one is not already available and starting it is needed for the requested check.

## Workflow

Set the absolute helper path once. `{baseDir}` is the directory containing this `SKILL.md`.

```bash
CDP="{baseDir}/scripts/cdp.mjs"
```

### 1. Open an isolated browser

```bash
node "$CDP" open --url http://127.0.0.1:8000/ --width 1440 --height 900
```

For a user-authorized external site, explicitly opt in:

```bash
node "$CDP" open --url https://example.com/ --allow-remote --width 1440 --height 900
```

This starts a temporary headless Chrome instance, binds its debugger to loopback only, and prints the page target. The default debugging port is `9222`; pass `--port <port>` when another local inspector owns it.

### 2. Inspect the page and interact deliberately

Use CSS selectors for simple interactions:

```bash
node "$CDP" click --selector '#next'
node "$CDP" click --selector '[data-example="solar"]'
node "$CDP" key --key ArrowRight
node "$CDP" navigate --url https://example.com/ --allow-remote
```

Use a narrowly scoped expression to query visible state or perform a custom local interaction:

```bash
node "$CDP" eval --expr "document.querySelector('.slide.active h2')?.textContent"
node "$CDP" eval --expr "document.querySelector('#function-stage .big-number')?.textContent"
```

Do not use `eval` to access credentials, storage, cookies, authentication tokens, or unrelated browser state.

### 3. Capture visual evidence

```bash
node "$CDP" screenshot --path /tmp/local-app-check.png --width 1440 --height 900
```

Read the resulting image with the available image/file-reading tool. Combine visual inspection with DOM/state checks: a correct DOM can still be clipped, invisible, or overlapped.

### 4. Report and fix only confirmed issues

- State what interaction was performed and what visible/DOM result was observed.
- If an issue is found, make a focused fix, then repeat the specific affected interaction and screenshot.
- Avoid claiming full browser coverage from a few manual checks.

### 5. Always clean up

```bash
node "$CDP" close
```

Run this in a final cleanup step even when inspection commands fail.

## Helper commands

```text
open       Start isolated headless Chrome and navigate to --url.
navigate   Navigate the selected page to --url.
status     Print the selected page target.
eval       Evaluate --expr in the selected page and return JSON-safe output.
click      Click one DOM element found by --selector.
key        Dispatch a keydown event using --key.
dom        Print an element's outer HTML; optionally limit with --selector.
screenshot Save a PNG using --path.
close      Stop the temporary Chrome process and remove its temporary profile.
```

Use `node "$CDP" <command> --help` for the command's options.

## Recommended checks for an interactive presentation

At a projector-sized viewport (for example 1440×900):

1. Verify the opening slide has visible content.
2. Navigate to at least one later slide. A common slide-system defect is that only the first slide receives its active/display class.
3. Exercise every interactive control category at least once: tabs, sliders, selectors, step-through buttons, and navigation keys.
4. Inspect a dense slide with controls or an information panel; confirm its bottom edge is inside the viewport.
5. Capture screenshots of the opening view and the densest interactive view.

## Limits

This helper is for focused, deterministic browser checks, not a replacement for a full browser testing framework. Use Playwright or a project test suite when the user needs broad regression coverage, multiple-browser coverage, network interception, or an automated test report.
