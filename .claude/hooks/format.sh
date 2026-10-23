#!/usr/bin/env sh
# PostToolUse hook: lint-fix and format the file Claude Code just edited.
# Reads the hook payload on stdin and pulls out tool_input.file_path.
# Always exits 0, so a formatting hiccup never blocks the session.

file=$(node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    try {
      process.stdout.write(JSON.parse(raw).tool_input?.file_path ?? "");
    } catch {
      /* not a payload we understand */
    }
  });
')

[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0

case "$file" in
  *.js | *.mjs | *.cjs | *.ts | *.mts | *.cts)
    pnpm exec oxlint --fix --no-error-on-unmatched-pattern "$file" >/dev/null 2>&1
    ;;
esac

pnpm exec oxfmt --no-error-on-unmatched-pattern "$file" >/dev/null 2>&1

exit 0
