# Contributing to goal-tasks

Issues and pull requests are welcome. The design lives in [`docs/PLAN.md`](docs/PLAN.md) (Portuguese); what came
out differently is in [`docs/DEVIATIONS.md`](docs/DEVIATIONS.md). Before a pull request, run the checks the
repository runs on itself:

```
bun test
cd opencode && bun test
claude plugin validate claude
claude plugin test claude
bun run typecheck
bun scripts/build.ts --check
```

No test calls a model; tests that need git and jlock make temporary repositories and their own `JLOCK_HOME`.

## Languages

Every text a person reads (answers, errors, help, the pane, the sidebar) comes from a catalog in `locales/<tag>.json`.
`en.json` is the reference: every other catalog has exactly its keys and the same `{markers}`, and English is the
fallback for a missing key. `test/i18n.test.ts` checks both, and that every line of `tasks help` fits in 100
columns in every language (wide characters count as two).

**Reviews of the text are accepted and welcome in any language, English included**: clarity, tone, the words
chosen. You do not need to know TypeScript to help: a pull request that only touches a JSON file is enough, or an
issue with the sentence as it is and your suggestion.

### Adding a language

1. Copy `locales/en.json` to `locales/<tag>.json` (a BCP 47 tag, like jlock's: `es`, `fr`, `de`, `it`, `zh-CN`,
   `ja`, `ru`, `ar`, `hi`).
2. Translate every value. Keep the `{markers}` exactly; reorder them as the language needs.
3. Plurals: a key with forms has `<key>_one` (exactly one, `{n}` = 1) and `<key>_other` (every other count). Use the
   same words as jlock's catalog for the same idea; the `_glossary` at the top of each file lists them (task, run,
   ownership, lock, queue, attempt, ticket, effect, undo).
4. Register the catalog in `src/i18n.ts` (`CATALOGS`), then run `bun scripts/build.ts` and `bun test`.

### What stays in English inside a translation

Action and option names (`tasks claim`, `--evidence`), environment variables (`GOAL_TASKS_*`, `JLOCK_*`), file
names (`tasks.json`, `run.json`), task and run ids, and result codes of the JSON when a sentence quotes them.

### Status of the languages

| Tag | Language | Status |
|---|---|---|
| `en` | English | complete (reference) |
| `pt-BR` | Português (Brasil) | complete |
