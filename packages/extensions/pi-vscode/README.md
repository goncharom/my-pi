# Pi Review

Pi Review bridges Pi plan and code reviews into a Remote-SSH VS Code window.

## Clickable file references

The Pi extension makes file references in final responses clickable in a terminal that supports OSC-8 links. Use Cmd+Shift-click in Ghostty to open the referenced remote file in VS Code.

To keep references consistent, add this to your `AGENTS.md`:

```text
When mentioning a repository file, use its workspace-relative path, optionally with :line[:column] (for example, `src/auth/session.ts:42`).
```
