# Contributing to jtasks

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
bun scripts/version.ts --check
```

No test calls a model; tests that need git and jlock make temporary repositories and their own `JLOCK_HOME`.

## Versions

Claude Code's `/plugin` decides whether an update exists by comparing the version in
`claude/.claude-plugin/plugin.json`, not the commits: a release that does not bump it is invisible ("already at the
latest version"). The version lives in five places (`package.json`, `VERSION` in `src/tool.ts`, which `jtasks version`,
`jtasks doctor` and the tool's description print, `claude/.claude-plugin/plugin.json`, the marketplace entry when it
states one, and `opencode/package.json`), and `test/version.test.ts` fails when they differ. To release:

```
bun scripts/version.ts 0.3.0     # writes it everywhere
bun scripts/build.ts             # the copies in dist/, claude/core/ and opencode/core/
bun test                         # and the other checks above
```

Then commit. Semantic versions: while jtasks is below 1.0, a release with new behaviour bumps the minor number
(0.2.0 → 0.3.0), one with fixes only bumps the patch (0.2.0 → 0.2.1). `claude plugin tag claude` can then create the
`jtasks--v<version>` tag, checking plugin.json and the marketplace agree.

## Languages

Every text a person reads (answers, errors, help, the pane, the sidebar) comes from a catalog in `locales/<tag>.json`.
`en.json` is the reference: every other catalog has exactly its keys and the same `{markers}`, and English is the
fallback for a missing key. `test/i18n.test.ts` checks both, and that every line of `jtasks help` fits in 100
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

Action and option names (`jtasks claim`, `--evidence`), environment variables (`JTASKS_*`, `JLOCK_*`), file
names (`tasks.json`, `run.json`), task and run ids, and result codes of the JSON when a sentence quotes them.

### Status of the languages

| Tag | Language | Status |
|---|---|---|
| `en` | English | complete (reference) |
| `pt-BR` | Português (Brasil) | complete |
| `es` | Español | complete |
| `fr` | Français | complete |
| `de` | Deutsch | complete |
| `it` | Italiano | complete |
| `zh-CN` | 简体中文 | complete, native review pending |
| `ja` | 日本語 | complete, native review pending |
| `ru` | Русский | complete, native review pending |
| `ar` | العربية | complete, native review pending |
| `hi` | हिन्दी | complete, native review pending |

The five marked "native review pending" were written without a native speaker and may sound stiff or strange. If
you speak one of them, a review is the most useful contribution you can make: open an issue with the sentence as it
is and your suggestion, or a pull request that changes only the JSON file. Arabic is printed as plain text in the
terminal (no bidirectional control characters), as jlock does.
