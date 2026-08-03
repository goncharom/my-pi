---
name: learn
description: Captures complex technical lessons into Markdown capsules and runs spaced-repetition reviews.
disable-model-invocation: true
---

# Learn

This skill manages a Markdown-based technical learning system for complex technical knowledge.

Never invoke this skill proactively. Use it only when the user explicitly invokes `/skill:learn`.

All learning data is stored under:

`{baseDir}/data/capsules/`

Every lesson is one Markdown capsule in that directory. Keep every capsule inside `{baseDir}/data/capsules/`.

Supported invocations:

- `/skill:learn capture`
- `/skill:learn capture <optional focus>`
- `/skill:learn import <path>`
- `/skill:learn review`
- `/skill:learn status`

## Routing

Inspect the arguments supplied after `/skill:learn`.

If the first argument is `capture`, follow the capture workflow.

If the first argument is `import`, follow the import workflow.

If the first argument is `review`, follow the review workflow.

If the first argument is `status`, follow the status workflow.

When no valid subcommand is supplied, briefly show exactly this usage shape:

```text
Usage:

/skill:learn capture [focus]
/skill:learn import <path>
/skill:learn review
/skill:learn status
```

## Division of responsibilities

Pi is responsible for semantic work:

- Understanding the current conversation.
- Reading imported notes.
- Inspecting referenced code when useful.
- Identifying lessons worth preserving.
- Writing and updating capsule contents.
- Avoiding duplicate capsules.
- Generating review questions.
- Evaluating user answers.
- Asking one targeted follow-up when needed.
- Assigning a score from `0` to `3`.

The Bash script is responsible for mechanical scheduling work:

- Scanning capsule files.
- Parsing frontmatter.
- Validating capsule metadata.
- Selecting a due capsule.
- Calculating review intervals.
- Updating scheduling metadata.
- Reporting database status.
- Preserving capsule bodies during scheduling updates.

Do not manually choose a capsule for review. Do not calculate review dates yourself. Run the Bash script for selection, validation, status, and scheduling updates.

## Capture workflow

For:

```text
/skill:learn capture
/skill:learn capture <optional focus>
```

Do the following:

1. Review the current conversation.
2. Use the optional focus to determine which lesson or lessons should be captured.
3. Identify one or more coherent lessons worth preserving.
4. Inspect referenced repository files when needed to ground vague or incomplete statements.
5. Search existing capsules for obvious duplicates by inspecting filenames, titles, and relevant capsule contents under `{baseDir}/data/capsules/`.
6. Create or update Markdown capsules under `{baseDir}/data/capsules/`.
7. Validate every created or updated capsule by running:

```bash
{baseDir}/scripts/learn validate <capsule-path>
```

8. Fix validation failures before finishing.
9. Respond with a concise list of capsules created or updated.

Do not create a staging area, candidate queue, separate index, SQLite database, embeddings, web interface, Anki integration, background agent, or proactive capture mechanism.

Good capsule subjects include:

- How a workflow operates.
- How components interact.
- Why a system is structured in a certain way.
- Architectural boundaries.
- Important invariants.
- Failure modes.
- Debugging lessons.
- Conceptual distinctions.
- How to reason about modifying a system.
- How data or control flows through several layers.

Avoid creating capsules for:

- Trivial commands.
- Conversation filler.
- Temporary implementation details.
- Exact filenames that are not conceptually important.
- Purely speculative ideas that were never resolved.
- Facts that do not require future understanding.

A capsule may preserve exact filenames, symbols, commands, or snippets as supporting context. The user should not normally be tested on recalling those exact details.

When the conversation contains vague references, inspect relevant files if useful and write the corrected, grounded explanation rather than copying the vague statement.

## Import workflow

For:

```text
/skill:learn import <path>
```

Do the following:

1. Resolve the supplied path.
2. If it is a Markdown file, read it.
3. If it is a directory, recursively find Markdown files and read the source material.
4. Identify coherent lessons worth reviewing.
5. Inspect referenced code when useful.
6. Search existing capsules for duplicates by inspecting filenames, titles, and relevant contents under `{baseDir}/data/capsules/`.
7. Create or update capsules under `{baseDir}/data/capsules/`.
8. Validate every created or updated capsule by running:

```bash
{baseDir}/scripts/learn validate <capsule-path>
```

9. Fix validation failures before finishing.
10. Report the number and titles of capsules written.

Do not create exactly one capsule per input file. One source file may contain several unrelated lessons, one large workflow, repeated explanations, unimportant pasted material, or partial notes that require code inspection. Several source files may contribute to one capsule. Organize imported material around concepts worth reviewing, not around original file boundaries.

The Bash script does not ingest, split, summarize, or understand source notes. You perform those tasks directly.

## Review workflow

For:

```text
/skill:learn review
```

Do not ask the user what topic they want to review. Do not manually choose a capsule. Do not ask whether they want to see sources.

Run:

```bash
{baseDir}/scripts/learn next
```

Parse the JSON returned on stdout.

If the result is:

```json
{
  "status": "empty"
}
```

respond:

```text
No capsules are currently due.
```

Then stop.

If the result has `"status": "ok"`, read the capsule at the returned `path` and ask one conceptual question based on the capsule.

The review loop is:

1. Run `{baseDir}/scripts/learn next`.
2. Parse the JSON response.
3. If no capsule is due, say `No capsules are currently due.` and stop.
4. Otherwise read the selected capsule.
5. Ask one initial review question.
6. Wait for the user's answer.
7. Evaluate conceptual understanding rather than exact wording.
8. If an important idea is missing, ask at most one targeted follow-up.
9. Assign a score from `0` to `3`.
10. Record every completed review by running:

```bash
{baseDir}/scripts/learn record <capsule-id> <score>
```

11. Run `{baseDir}/scripts/learn next` again.
12. Continue until no capsules are due, the user asks to stop, or the user changes topics.

Do not expose sources after every review. Use sources only as needed to evaluate or explain.

## Status workflow

For:

```text
/skill:learn status
```

Run:

```bash
{baseDir}/scripts/learn status
```

Summarize the result concisely, for example:

```text
42 capsules total. 7 are due, and 18 have never been reviewed.
```

Do not read capsule bodies during this workflow.

## Capsule format

Each capsule is one Markdown file in:

`{baseDir}/data/capsules/`

The filename must match the capsule ID:

```text
quote-request-lifecycle.md
```

Every capsule must contain this frontmatter:

```yaml
---
id: quote-request-lifecycle
created: 2026-07-21
due: 2026-07-21
interval_days: 2
review_count: 0
last_reviewed:
last_score:
---
```

Required fields:

- `id`
- `created`
- `due`
- `interval_days`
- `review_count`
- `last_reviewed`
- `last_score`

The `id` must be stable and contain only lowercase letters, numbers, and hyphens. The filename must be `<id>.md`.

`created` is the original capsule creation date and should not change when the capsule is updated.

`due` is the next review date. New capsules should be immediately due.

`interval_days` starts at `2` for new capsules. The scheduler's minimum interval after any completed review is 2 days.

`review_count` starts at `0` for new capsules.

`last_reviewed` is empty before the first review.

`last_score` is empty before the first review.

Everything after the frontmatter is freeform Markdown. The body may include explanations, workflows, mental models, code snippets, commands, symbols, file references, failure scenarios, design constraints, and review targets.

The body must contain enough information for Pi to generate a useful question, evaluate the user's answer, identify missing concepts, and ask one targeted follow-up. Avoid rigid question-and-answer flashcard formatting. A capsule represents a complete lesson, not a single trivia fact.

## Duplicate handling

Before creating a capsule, inspect existing filenames, titles, and relevant existing capsule contents under `{baseDir}/data/capsules/`.

If the concept already exists, update the existing capsule. Preserve existing scheduling metadata:

```yaml
created:
due:
interval_days:
review_count:
last_reviewed:
last_score:
```

Only update the explanatory Markdown body unless scheduling metadata is missing or invalid.

When creating a new capsule, generate a concise slug. If the slug is already used for a different lesson, append a suffix:

```text
request-dispatch.md
request-dispatch-2.md
request-dispatch-3.md
```

The Bash script does not perform semantic deduplication.

## Review-question rules

Questions should test understanding through:

- Workflow reconstruction.
- Causal explanation.
- Failure diagnosis.
- Application to a new scenario.
- Comparison between concepts.
- Reasoning about a modification.
- Identifying constraints or invariants.

Do not test exact filenames, symbols, syntax, or method signatures unless those details are essential to understanding the lesson.

Good question shape:

```text
Trace the quote request from the HTTP endpoint until background processing begins. Where is the synchronous boundary, and why must persistence happen before publication?
```

Bad question shape:

```text
Which file contains QuoteService?
```

Ask one initial review question. Ask at most one targeted follow-up if an important idea is missing.

## Scoring rules

Use this scale:

```text
0 = Incorrect or unable to explain
1 = Partial understanding with important gaps
2 = Correct understanding of the core model
3 = Strong understanding, including implications or application
```

Use `0` when the answer is mostly incorrect, the user cannot recall the concept, or the answer contradicts the capsule's core explanation.

Use `1` when the user remembers part of the lesson, but important relationships are missing or the answer is directionally correct but incomplete.

Use `2` when the user correctly explains the main concept and the essential workflow or reasoning is present. Missing details should not undermine the core model.

Use `3` when the answer is correct and confident, explains implications or failure modes, or applies the lesson to a new scenario.

Pi selects the score. The Bash script only records it. Record every completed review with:

```bash
{baseDir}/scripts/learn record <capsule-id> <score>
```
