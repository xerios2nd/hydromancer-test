# Claude Code Instructions

## Stack

Always use `pnpm`, never `npm` or `yarn`.

## Scope

- Keep changes narrowly scoped to the requested task.
- Do not refactor unrelated code.
- Do not perform opportunistic cleanup.
- Do not modify generated files unless explicitly requested.

## Formatting

Formatting is handled by Oxfmt, and it runs automatically.

- A `PostToolUse` hook formats every file after you edit it.
- Do not manually format code.
- Do not run `pnpm fmt` or `pnpm check:fmt` just to check formatting.
- Do not spend time fixing whitespace, indentation, quotes, semicolons, or import formatting.
- The project's automated tooling handles formatting.

## Validation

Use the project's validation command:

```bash
pnpm check
```

For substantive code changes, run `pnpm check` after implementation.

Do not separately run type checking, linting, or the full test suite when `pnpm check` already covers them.

### Validation by change type

- Documentation-only changes: no validation required.
- Comments-only changes: no validation required.
- CSS/styling-only changes: use judgment; avoid the full test suite unless behavior could be affected.
- Trivial UI changes: use judgment; avoid unnecessary full-suite tests.
- Logic/behavior changes: run `pnpm check`.
- Changes to tests: run the relevant tests.
- Before completing a substantial task: run `pnpm check`.

If validation fails:

1. Read the failure.
2. Fix the underlying problem.
3. Re-run only the relevant failing check while debugging (`pnpm check:types`, `pnpm check:lint`, or a targeted Vitest run).
4. Once fixed, run `pnpm check` once more if appropriate.

Do not repeatedly run successful checks.

## Linting

- Fix the code rather than silencing the rule.
- Do not add `oxlint-disable` comments unless the rule is genuinely wrong for that line, and say why in the comment.
- Do not edit `.oxlintrc.json` to make an error go away.
- Oxlint only sees the `<script>` blocks of `.svelte` files. Template-level problems will not be caught by the linter, so read the markup yourself.

## Tests

- Prefer targeted Vitest tests while debugging: `pnpm exec vitest run src/lib/thing.test.ts`.
- Do not run the entire test suite after every edit.
- Only add tests relevant to the requested behavior.
- Do not rewrite existing tests unless necessary.
- Do not chase unrelated failing tests.

## Svelte

- Svelte 5 runes only: `$state`, `$derived`, `$effect`, `$props`. No `export let`, no legacy stores, no `on:click`.
- Shared reactive state belongs in `*.svelte.ts` modules.
- Follow the existing project's Svelte conventions.
- Reuse existing components/utilities before creating new abstractions.
- Do not introduce a new dependency unless necessary.
- Keep component changes focused on the requested behavior.

## Security

Two things the linter cannot see:

- `{@html ...}` in Svelte markup. Sanitize the value first, then annotate the line with `<!-- allow-html: reason -->` explaining why it is safe.
- Secret-looking names on `VITE_` variables. Anything prefixed `VITE_` is inlined into the client bundle, so it is public. Never put a token, key, or password behind that prefix.

Other rules:

- Never commit a `.env` file. Add new public variables to `.env.example`.
- Adding a dependency means adding a supply-chain risk. Ask before introducing one, and never add an entry to `allowBuilds` in `pnpm-workspace.yaml` — that authorises a package to run code at install time.
- Do not edit `.claude/` as a side effect of another task. Those files execute with full privileges.

## Sandbox

Bash commands run in Claude Code's sandbox. Writes are limited to this working directory and network access is limited to the npm registry.

- If a command fails on a blocked path or host, report it instead of working around it.
- Do not weaken `.claude/settings.json` to make a command pass.
- Adding a dependency needs a real justification; the install itself is allowed.

## Completion

When the requested change is implemented and relevant validation passes, stop.

Do not perform additional cleanup, formatting passes, refactoring, or self-review unless requested.
