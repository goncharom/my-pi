# Pi Extra Prompts

Refresh your Markdown instructions on **every model request**, including requests after tool results. No bundled prompts.

## Install

```sh
pi install ./packages/extensions/pi-extra-prompts
```

Run `/reload` if Pi is already open.

## Add instructions

Use a single Markdown file per scope:

- **Global:** `~/.pi/agent/extra-prompts.md` (respects `PI_CODING_AGENT_DIR`).
- **Project:** `<project>/.pi/extra-prompts.md`.

Like Pi's context-file discovery, project files are also discovered in parent directories, so they apply when Pi runs in a project subdirectory. Files are combined global first, then ancestor projects from outermost to innermost. Missing or empty files are ignored. Without any instructions, the extension does nothing.

Put multiple instructions or sections in the same file. These are not slash-command templates. Run `/reload` after editing.

### Example: GitHub source links

The following is the current content of the author's global `~/.pi/agent/extra-prompts.md`. Copy it into your global or project file to enable the same behavior; the extension does not install it automatically.

```markdown
## GitHub source references

- Whenever you mention a repository file in prose, make its name a clickable Markdown link to its GitHub source, not just inline code. Example: [`src/auth.ts`](https://github.com/owner/repo/blob/COMMIT/src/auth.ts).
- Include `#L42` or `#L42-L57` when you already know the relevant lines. Never invent line numbers. Link symbol names to their source location when known.
- Put a source link immediately above code snippets copied from the repository; do not try to put links inside fenced code blocks.
- Do not fabricate repository URLs or source locations. For files outside this repository, illustrative examples, or code known to be local-only/unpublished, say so rather than providing a misleading GitHub link. If current code differs from the committed source, label the link as the committed version and omit inaccurate line anchors.
- Do not run tools solely to satisfy this formatting instruction. Use the supplied workspace metadata and locations already known from the conversation. If they are insufficient, leave the reference unlinked rather than guessing.
```

## How it works

At session startup, the extension reads the configured files. If any instructions exist, it uses two local Git commands to cache the origin GitHub URL, repository root, and HEAD commit. It makes no network requests. Non-Git projects and non-GitHub remotes still receive the instructions, without GitHub metadata.

The `context` hook appends one hidden, request-local instruction message immediately before every conversational model call. No extra model calls, model-invoked tools, or per-request filesystem/Git work. Instructions are not saved in history and do not accumulate. Compaction cannot remove them from subsequent requests. Internal calls for tasks such as compaction summaries are outside this hook.

This is a near-the-end reminder, not a system-role override or an enforcement mechanism. The model can still miss links, and the extra text adds input tokens. Other applicable higher-priority instructions still take precedence.

When your instructions request GitHub links, the cached HEAD commit provides a stable source URL prefix. The extension cannot verify that it was pushed; your instructions should tell the model not to present local-only code as published source or invent line numbers. Run `/reload` after changing repository/HEAD if you need fresh metadata. Clicking links depends on your terminal's hyperlink support.

## Development

```sh
pnpm --filter pi-extra-prompts test
```
