# template-svelte-oxc

Svelte 5 + TypeScript + Vite + Vitest, linted with Oxlint, formatted with Oxfmt, packaged with pnpm, and set up for Claude Code with the Bash sandbox enabled.

## Setup

```bash
pnpm install
git init
chmod +x .claude/hooks/format.sh
pnpm dev
```

## Scripts

| Command            | What it does                                      |
| ------------------ | ------------------------------------------------- |
| `pnpm dev`         | Vite dev server                                   |
| `pnpm build`       | Production build                                  |
| `pnpm check`       | Types → lint → tests. The one command agents run. |
| `pnpm check:types` | `svelte-check`                                    |
| `pnpm check:lint`  | `oxlint --deny-warnings`                          |
| `pnpm check:tests` | `vitest run`                                      |
| `pnpm check:fmt`   | `oxfmt --check` (locally it's automatic)          |
| `pnpm test`        | Vitest in watch mode                              |
| `pnpm lint`        | `oxlint --fix`                                    |
| `pnpm fmt`         | `oxfmt` (writes)                                  |

`check:fmt` is deliberately left out of `pnpm check`. Formatting is applied automatically by the Claude Code hook, so making an agent verify it is wasted work.

## Formatting and linting

**Oxfmt** replaces Prettier. `.svelte` support is delegated to a bundled `prettier-plugin-svelte`, which needs two things, both already done here: the `svelte` package installed, and `"svelte": true` in `.oxfmtrc.json`. Without that flag, `.svelte` files are silently skipped.

Note that Oxfmt defaults to `printWidth: 100`, not Prettier's 80. Set it explicitly in `.oxfmtrc.json` if your team wants 80.

**Oxlint** replaces ESLint. It only parses the `<script>` blocks of `.svelte` files — there is no template linting, so rules like `eslint-plugin-svelte`'s markup checks have no equivalent yet. `svelte-check` covers a good part of that gap.

## Claude Code sandbox

`.claude/settings.json` turns on the Bash sandbox, which runs shell commands under OS-level filesystem and network isolation (Seatbelt on macOS, bubblewrap on Linux and WSL2). The settings here:

- `enabled` + `autoAllowBashIfSandboxed`: commands run without a prompt for each one, because the boundary contains them.
- `allowUnsandboxedCommands: false`: strict mode. Claude cannot retry a failed command outside the sandbox. Drop this key if the escape hatch is more useful to you than the guarantee.
- `network.allowedDomains`: the npm registry only. Anything else prompts.
- `credentials`: SSH keys, AWS and `gh` credentials, and `~/.npmrc` are unreadable inside the sandbox; token env vars are unset before each command.
- `permissions.deny`: `.env` files, `.pem` and `.key` files are off limits to the Read tool as well.

On Linux and WSL2 you need two packages first:

```bash
sudo apt-get install bubblewrap socat     # or: sudo dnf install bubblewrap socat
```

Run `/sandbox` in Claude Code to confirm everything resolved; the Config tab shows the settings as applied. Native Windows is not supported — use WSL2.

Two caveats worth knowing. The proxy filters by hostname without inspecting TLS, so a broad domain allowlist is a data-exfiltration path; keep the list tight. And with strict mode on, `git merge` or `git checkout` can fail with `unable to unlink old` when they need to touch a protected path — run those yourself in another terminal.

Per-developer overrides go in `.claude/settings.local.json`, which is gitignored.

## Security

The pieces below are the ones that are not obvious from the file tree.

**Supply chain.** `pnpm-workspace.yaml` carries the settings that matter more than anything else here. `allowBuilds` is an allowlist of packages permitted to run install scripts — currently just esbuild, and every addition is a package you have authorised to execute code on your machine. `minimumReleaseAge` keeps pnpm 11's one-day cooldown with `minimumReleaseAgeStrict: true` added, so a too-new version fails the install instead of silently resolving to an older one. A week is safer in principle, but in practice it blocks current releases of fast-moving tools — oxfmt and oxlint both tripped it while this template was being built. The cooldown works because detection is fast: the Shai-Hulud worm was identified in roughly twelve hours, the chalk/debug compromise in about two and a half. Use `minimumReleaseAgeExclude` for a genuine emergency patch, then remove the exception.

**Claude Code.** The sandbox contains what a command can reach; it does nothing about prompt injection. Two things follow. Hooks run _outside_ the sandbox, so `.claude/hooks/format.sh` executes with your full privileges on every edit — it deserves review like a CI script. And `env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips Anthropic and cloud credentials from all subprocesses, sandboxed or not, which is broader than the `credentials.envVars` denies. Resist widening `allowedDomains` the first time something fails: the proxy allows by client-supplied hostname without inspecting TLS, so a broad entry is an exfiltration path. An MCP server is remote code with tool access — treat `.mcp.json` as a dependency manifest.

**Deploy.** `public/_headers` carries a CSP with no `unsafe-inline` for scripts, plus HSTS, `nosniff`, `Referrer-Policy`, and `Permissions-Policy`. The syntax is Netlify/Cloudflare Pages; translate it if you host elsewhere. Keep auth tokens in httpOnly SameSite cookies, not `localStorage`. And don't run `vite dev --host` on an untrusted network — the dev server has a history of path-traversal issues, so keep Vite patched even as a dev dependency.

## Notes

- `pnpm-workspace.yaml` holds pnpm settings, including the build-script allowlist. pnpm no longer runs postinstall scripts unless a package is listed there, so add any dependency that needs one.
- The counter in `src/lib/counter.svelte.ts` is the pattern for shared reactive state: a `.svelte.ts` module exporting a factory, testable in plain Vitest without a DOM.
- Dependency versions are floors, not pins. `pnpm up --latest` before you start building on this.
