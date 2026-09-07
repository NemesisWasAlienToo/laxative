#!/usr/bin/env bash
# Runs the extension in a throwaway VS Code, preloaded with a sample project.
# Your local VS Code, its settings and its extensions are never touched, and
# everything lives in a temp directory removed when you press Ctrl+C.
#
#   ./docker/try-it.sh          real VS Code over noVNC -> http://localhost:8443/vnc.html
#   ./docker/try-it.sh --web    code-server in the browser -> http://localhost:8443
#   PORT=9000 ./docker/try-it.sh
#
# The default is real desktop VS Code. code-server serves webviews through a
# service worker, which browsers only allow on http://localhost or over HTTPS,
# so reaching it by LAN address or through a proxy silently breaks every
# webview -- the note panel, the graph, and VS Code's own markdown preview.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8443}"
MODE="desktop"
[ "${1:-}" = "--web" ] && MODE="web"

if [ ! -f "$ROOT/dist/laxative.vsix" ]; then
  echo "Building the extension first..."
  "$ROOT/docker/test.sh" package
fi

SANDBOX="$(mktemp -d)"
cleanup() {
  docker rm -f laxative-try >/dev/null 2>&1 || true
  rm -rf "$SANDBOX"
  echo "Sandbox removed."
}
trap cleanup EXIT

mkdir -p "$SANDBOX/home" "$SANDBOX/project/src"

cat > "$SANDBOX/project/src/cache.ts" <<'SAMPLE'
export class Cache {
  private entries = new Map<string, unknown>();

  get(key: string): unknown {
    return this.entries.get(key);
  }

  set(key: string, value: unknown): void {
    // The warmer writes here on a background timer.
    this.entries.set(key, value);
  }

  evictAll(): void {
    this.entries.clear();
  }
}
SAMPLE

cat > "$SANDBOX/project/src/worker.ts" <<'SAMPLE'
import { Cache } from './cache';

export async function warm(cache: Cache, keys: string[]): Promise<void> {
  for (const key of keys) {
    let attempt = 0;
    while (attempt < 3) {
      try {
        cache.set(key, await load(key));
        break;
      } catch {
        attempt++;
      }
    }
  }
}

async function load(key: string): Promise<unknown> {
  return { key };
}
SAMPLE

cat > "$SANDBOX/project/README.md" <<'SAMPLE'
# Sample project

1. Put the cursor on a line in `src/cache.ts` and press `Ctrl+Alt+M`. A markdown
   editor opens beside it. Write a title line, some **bold** text and a `#bug`
   hashtag, then save with `Ctrl+S`.
2. Click the CodeLens above that line to open the reading panel. Leave it open
   beside the editor: it re-renders as you type, before you save.
3. Add a second note in `src/worker.ts`. In its editor type `[[` and pick the
   first note; type `#` to reuse a hashtag.
4. Open the **Laxative** view in the activity bar, then the **Note Graph**
   tab in the bottom panel, next to Terminal.
5. `git status`: only `.laxative/notes.json` changed. Your source files were
   never modified.

If a webview ever looks blank, run **Laxative: Show Rendering Diagnostics**:
it reports what each webview actually put on screen.
SAMPLE

git -C "$SANDBOX/project" init -q
git -C "$SANDBOX/project" add -A
git -C "$SANDBOX/project" -c user.email=sandbox@local -c user.name=sandbox commit -qm "sample project"

if [ "$MODE" = "web" ]; then
  echo "Installing the extension into the code-server sandbox..."
  docker run --rm \
    -u "$(id -u):$(id -g)" -e HOME=/home/coder \
    -v "$SANDBOX/home:/home/coder" \
    -v "$ROOT/dist/laxative.vsix:/tmp/laxative.vsix:ro" \
    --entrypoint code-server codercom/code-server:latest \
    --install-extension /tmp/laxative.vsix

  cat <<EOF

  code-server: http://localhost:${PORT}
  Open it on localhost exactly as printed. Over a LAN address or a proxy the
  browser refuses the service worker code-server needs and every webview goes
  blank, including VS Code's own markdown preview. Use real VS Code
  (./docker/try-it.sh with no flag) if you need webviews over the network.

EOF
  exec docker run --rm -it --name laxative-try \
    -p "${PORT}:8080" \
    -u "$(id -u):$(id -g)" -e HOME=/home/coder \
    -v "$SANDBOX/home:/home/coder" \
    -v "$SANDBOX/project:/home/coder/project" \
    --entrypoint code-server codercom/code-server:latest \
    --bind-addr 0.0.0.0:8080 --auth none --disable-telemetry --disable-update-check \
    /home/coder/project
fi

docker build -q -f "$ROOT/docker/Dockerfile" -t laxative-test "$ROOT" >/dev/null
docker volume create laxative-vscode-cache >/dev/null

cat <<EOF

  Real VS Code: http://localhost:${PORT}/vnc.html   (click Connect)
  The same desktop build the tests run against, so webviews behave exactly as
  they do locally. The first start downloads VS Code into a cache volume.

EOF

exec docker run --rm -it --name laxative-try \
  -p "${PORT}:8080" \
  -e "PORT=${PORT}" \
  -v "$ROOT:/src:ro" \
  -v "$ROOT/dist:/out:ro" \
  -v "$SANDBOX/project:/workspace" \
  -v laxative-vscode-cache:/cache \
  laxative-test desktop
