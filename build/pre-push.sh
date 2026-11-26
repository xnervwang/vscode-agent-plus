#!/bin/bash
# BSD 3-Clause License
# Copyright (c) 2026, Xnerv Wang
# All rights reserved.

# What a push of Agent Plus is checked for first (.githooks/pre-push runs it): the suite, the package build/pack.sh
# makes, and that package installed in a VS Code of its own, where the window test's first two steps need Agent Plus
# started: "alone" waits for its notice, "first-start" for a source to register with it. A file the package leaves out
# that the extension loads stops it there, which the suite, run from the repository, cannot see.
#
# Needs what test/vscode/run.js needs: @vscode/test-electron and playwright-core where node finds them (NODE_PATH), and
# on Linux a display, or xvfb-run. AGENT_PLUS_VSCODE names a VS Code executable to run instead of downloading one; the
# two steps have Agent Plus raise the request limit in that VS Code's service-worker.js (src/webview-limit.js), and the
# file is put back as it was afterwards, since a later run needs the limit VS Code ships.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
out=$(mktemp -d)
if ! node test/check.js > "$out/check.log" 2>&1; then
  grep -E 'FAIL|passed' "$out/check.log"; echo "the suite failed; its output is in $out/check.log"; exit 1
fi
vsix=$(bash build/pack.sh | tail -n 1)
run=(node test/vscode/run.js "$vsix" --out "$out/window" --local)
worker=''
if [ -n "${AGENT_PLUS_VSCODE:-}" ]; then
  run+=(--vscode "$AGENT_PLUS_VSCODE")
  # Beside the executable on Linux and Windows; in Contents/Resources of the app on macOS, one folder up.
  for base in "$(dirname "$AGENT_PLUS_VSCODE")" "$(dirname "$AGENT_PLUS_VSCODE")/.."; do
    worker=$(find "$base" -maxdepth 12 -path '*/webview/browser/pre/service-worker.js' 2>/dev/null | head -n 1)
    if [ -n "$worker" ]; then break; fi
  done
  if [ -n "$worker" ]; then cp "$worker" "$out/service-worker.js"; trap 'cp "$out/service-worker.js" "$worker"' EXIT; fi
fi
if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ]; then
  # A display number of its own, as another run under xvfb-run -a can take the same one at the same time.
  run=(xvfb-run -n $((200 + RANDOM % 700)) -s '-screen 0 1600x1000x24' "${run[@]}")
fi
if AGENT_PLUS_UI_STEPS='^(alone|first-start)$' "${run[@]}" > "$out/window.log" 2>&1; then
  echo "$(basename "$vsix") installs and starts: $(tail -n 1 "$out/window.log")"
  if [ -n "$worker" ]; then cp "$out/service-worker.js" "$worker"; trap - EXIT; fi
  rm -rf "$out"
  exit 0
fi
grep -E 'FAIL|VS Code window' "$out/window.log" || tail -n 20 "$out/window.log"
echo "the package did not start once installed; the run is in $out"
exit 1
