#!/bin/bash
# Copies the read-only source mount into a scratch dir, links the prebuilt
# node_modules, and runs the requested task. Nothing is written to the host
# except what is explicitly copied into /out.
set -euo pipefail

cp -a /src/. /work/ 2>/dev/null || true
rm -rf /work/node_modules
ln -sfn /deps/node_modules /work/node_modules
cd /work

run_unit() {
  echo "=== typecheck ==="
  npx tsc --noEmit -p tsconfig.json
  echo "=== unit tests ==="
  npx tsc -p tsconfig.test.json
  npx mocha 'out-test/test/unit/**/*.test.js'
}

run_integration() {
  echo "=== build ==="
  node esbuild.mjs
  echo "=== integration tests (headless VS Code) ==="
  npx tsc -p tsconfig.test.json
  xvfb-run -a --server-args="-screen 0 1280x1024x24" node out-test/test/integration/runTests.js
}

run_package() {
  echo "=== package ==="
  node esbuild.mjs
  npx vsce package --no-dependencies --allow-missing-repository -o /work/laxative.vsix
  mkdir -p /out && cp /work/laxative.vsix /out/laxative.vsix
  echo "wrote /out/laxative.vsix"
}

# Real VS Code, on a virtual display, reachable from a browser over noVNC.
# Unlike code-server this is the actual desktop build, so webviews (the note
# panel, the graph, markdown preview) behave exactly as they do locally.
run_desktop() {
  local exe cli sandbox resolved
  resolved=$(node docker/resolve-vscode.mjs | tail -2)
  exe=$(echo "$resolved" | head -1)
  cli=$(echo "$resolved" | tail -1)
  sandbox=/work/.vscode-sandbox
  mkdir -p "$sandbox/user" "$sandbox/ext"

  export DISPLAY=:99
  Xvfb :99 -screen 0 "${SCREEN:-1680x1050x24}" -nolisten tcp &
  for _ in $(seq 1 40); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.25; done
  openbox &
  x11vnc -display :99 -forever -shared -nopw -quiet -bg -rfbport 5900
  websockify --web=/usr/share/novnc 8080 localhost:5900 &

  local args="--no-sandbox --disable-gpu --disable-updates --skip-welcome     --skip-release-notes --disable-workspace-trust     --user-data-dir=$sandbox/user --extensions-dir=$sandbox/ext"

  if [ -f /out/laxative.vsix ]; then
    # The CLI wrapper, not the GUI binary: the latter ignores --install-extension.
    "$cli" --user-data-dir="$sandbox/user" --extensions-dir="$sandbox/ext" \
      --install-extension /out/laxative.vsix
  else
    echo "warning: /out/laxative.vsix not found; run ./docker/test.sh package first" >&2
  fi
  echo "=== VS Code is up: open http://localhost:${PORT:-8443}/vnc.html ==="
  # shellcheck disable=SC2086
  exec "$exe" $args /workspace
}

# Publishing, so it works on a machine with no node installed.
run_publish() {
  local target="${2:-marketplace}" bump="${3:-}"
  node esbuild.mjs
  case "$target" in
    marketplace)
      [ -n "${VSCE_PAT:-}" ] || { echo "VSCE_PAT is not set" >&2; exit 1; }
      npx vsce publish --no-dependencies $bump
      ;;
    openvsx)
      [ -n "${OVSX_PAT:-}" ] || { echo "OVSX_PAT is not set" >&2; exit 1; }
      npx ovsx publish --no-dependencies -p "$OVSX_PAT"
      ;;
    *) echo "unknown publish target: $target" >&2; exit 1 ;;
  esac
}

case "${1:-all}" in
  publish) run_publish "$@" ;;
  desktop) run_desktop ;;
  unit) run_unit ;;
  integration) run_integration ;;
  package) run_package ;;
  all) run_unit; run_integration; run_package ;;
  shell) exec bash ;;
  *) exec "$@" ;;
esac
