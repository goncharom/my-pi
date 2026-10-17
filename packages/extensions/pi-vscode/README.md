# Pi Review

Pi Review bridges Pi plan and code reviews into a Remote-SSH VS Code window.

## Code reviews

Right-click a commit in VS Code's Source Control graph and choose **Open Changes**.
Add change requests or questions anywhere in that multi-file editor, then use
**Send Code Review to Pi** in the editor toolbar to send all unresolved comments
across the review. Edited, added, deleted, and renamed files are included.

Standalone file diffs and individual Git revision editors are not code review
scopes. Comments are scoped to the repository and both revisions, so feedback
from another commit is not included just because it shares a file or parent.
Published plan reviews are unchanged.

The multi-diff tab API is not yet in VS Code's stable typings. The extension
feature-detects its `textDiffs` property without enabling proposed APIs. VS Code
currently omits one-sided files from that list, so the full file set is read from
Git. For commits containing only additions/deletions, the built-in Git editor's
`<commit id> - <subject>` title and a displayed Git document identify the commit.

Run the build and regression tests from `packages/vscode-extension`:

```sh
pnpm run build
pnpm test
```

## Clickable file references

The Pi extension makes file references in final responses clickable in a terminal that supports OSC-8 links. Use Cmd+Shift-click in Ghostty to open the referenced remote file in VS Code.

To keep references consistent, add this to your `AGENTS.md`:

```text
When mentioning a repository file, use its workspace-relative path, optionally with :line[:column] (for example, `src/auth/session.ts:42`).
```
