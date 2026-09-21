#!/usr/bin/env bash
# Every check in this repo, in one command.
#
# Exists for the same reason the Finance Dashboard's does: the habit of
# running only the suites whose files you just edited is wrong, because an
# edit to one file routinely breaks a check on another. Changing the leave
# engine's injected working-day function (#453) is exactly that — it touched
# leaveEngine.js and App.jsx and the thing it could break was a test for
# neither.
#
#   bash tools/run_all_tests.sh
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
for t in tools/*.mjs tools/*.cjs; do
  [ -e "$t" ] || continue
  if node "$t" >/dev/null 2>&1; then
    printf '  PASS  %s\n' "$t"
  else
    printf '  FAIL  %s\n' "$t"
    node "$t" 2>&1 | tail -8 | sed 's/^/          /'
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  printf '\nSomething is failing. A suite that ERRORS prints a stack trace and no\nresults at all — that is a failure too, not an absence of one.\n'
  exit 1
fi
printf '\nAll checks pass.\n'
