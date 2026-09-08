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

mkdir -p "$SANDBOX/home" "$SANDBOX/project/src" "$SANDBOX/project/.laxative"

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

cat > "$SANDBOX/project/src/api.ts" <<'SAMPLE'
import { Cache } from './cache';
import { warm } from './worker';

const cache = new Cache();

export async function prime(keys: string[]): Promise<void> {
  await warm(cache, keys);
}

export function read(key: string): unknown {
  return cache.get(key);
}
SAMPLE

# Six notes are seeded so every visual is on screen the moment VS Code opens,
# without having to write any first: three files (three node colours), a hub
# note with four links, a note with no tags, a nested tag, rich markdown with a
# code fence, and one deliberately dangling reference.
cat > "$SANDBOX/project/.laxative/notes.json" <<'SAMPLE'
{
  "version": 1,
  "notes": [
    {
      "id": "d8m2rk44",
      "title": "Public surface: keep it to two calls",
      "body": "Public surface: keep it to two calls\n\nEverything else is internal. If a third call shows up here, it probably\nbelongs in [[p1x8dd02|the worker]] instead.\n\n#api\n",
      "file": "src/api.ts",
      "line": 5,
      "character": 0,
      "tags": [
        "api"
      ],
      "createdAt": "2026-09-01T09:00:00.000Z",
      "updatedAt": "2026-09-01T09:00:00.000Z"
    },
    {
      "id": "zz10lost",
      "title": "Read path is not memoised",
      "body": "Read path is not memoised\n\nDeliberately: the cache *is* the memo. This note also references a note that\ndoes not exist, [[nosuchnote]], so you can see how a dangling reference is\nrendered.\n\n#api #perf\n",
      "file": "src/api.ts",
      "line": 9,
      "character": 0,
      "tags": [
        "api",
        "perf"
      ],
      "createdAt": "2026-09-01T09:00:00.000Z",
      "updatedAt": "2026-09-01T09:00:00.000Z"
    },
    {
      "id": "k3f9a2mx",
      "title": "Race with the cache warmer",
      "body": "Race with the cache warmer\n\n`set()` is called from the background warmer **and** from request handlers,\nwith no lock between them. Two writers interleave and the loser's value is\nthe one that sticks.\n\nSee [[p1x8dd02|the retry loop]] and [[t7q4zz10|eviction]].\n\n#bug #perf/hot-path\n",
      "file": "src/cache.ts",
      "line": 7,
      "character": 2,
      "tags": [
        "bug",
        "perf/hot-path"
      ],
      "createdAt": "2026-09-01T09:00:00.000Z",
      "updatedAt": "2026-09-01T09:00:00.000Z"
    },
    {
      "id": "t7q4zz10",
      "title": "Eviction drops warm entries",
      "body": "Eviction drops warm entries\n\n`evictAll()` throws away everything the warmer just paid for, so the next\nrequest storm goes straight to the origin. Evict by age instead.\n\nSame underlying problem as [[k3f9a2mx]].\n\n#perf/hot-path\n",
      "file": "src/cache.ts",
      "line": 12,
      "character": 2,
      "tags": [
        "perf/hot-path"
      ],
      "createdAt": "2026-09-01T09:00:00.000Z",
      "updatedAt": "2026-09-01T09:00:00.000Z"
    },
    {
      "id": "p1x8dd02",
      "title": "Retry loop swallows the error",
      "body": "Retry loop swallows the error\n\nThree attempts, then we move on in silence:\n\n- no backoff, so all three usually fail for the same reason\n- the caught error is never logged\n- the caller cannot tell a cold key from a broken one\n\n```ts\n} catch {\n  attempt++;   // <- the whole diagnosis, gone\n}\n```\n\nRelated to [[k3f9a2mx|the warmer race]]. #bug #logging\n",
      "file": "src/worker.ts",
      "line": 5,
      "character": 6,
      "tags": [
        "bug",
        "logging"
      ],
      "createdAt": "2026-09-01T09:00:00.000Z",
      "updatedAt": "2026-09-01T09:00:00.000Z"
    },
    {
      "id": "w0b5neq7",
      "title": "load() is a stub in this sandbox",
      "body": "load() is a stub in this sandbox\n\nIt returns the key back. Left untagged on purpose, so the Notes view has\nsomething to put under \"untagged\" when you group by hashtag.\n",
      "file": "src/worker.ts",
      "line": 16,
      "character": 0,
      "tags": [],
      "createdAt": "2026-09-01T09:00:00.000Z",
      "updatedAt": "2026-09-01T09:00:00.000Z"
    }
  ]
}
SAMPLE

cat > "$SANDBOX/project/README.md" <<'SAMPLE'
# Sample project

Six notes are already attached to the files in `src/`, so everything is on
screen the moment this opens. Nothing in the source files was modified to put
them there.

## Look at, in order

1. **`src/cache.ts`** - gutter bubbles, the dimmed title at the end of the line
   and the CodeLens above it. Hover a marked line for the rendered note.
2. **The reading panel** - click the CodeLens on line 8. Check the toolbar
   (Edit / Go to code / Copy reference, Delete pushed to the right), the
   location link, and the `#bug` `#perf/hot-path` chips.
3. **`src/worker.ts` line 6** - that note has a list and a fenced code block,
   for checking markdown rendering; `src/api.ts` line 10 has a reference that
   points at nothing, for checking how a dangling `[[ref]]` is rendered.
4. **The Laxative view** in the activity bar - six notes over three files.
   Switch it to **Group by Hashtag**: `#bug` and `#perf/hot-path` have two
   notes each, and `load() is a stub` sits under *untagged*.
5. **The Note Graph** tab in the bottom panel, next to Terminal:
   - three node colours, one per file;
   - *Race with the cache warmer* is the biggest node - it has four links;
   - solid arrows are `[[refs]]`, faint dashes join notes sharing a file or tag;
   - **drag a node anywhere and let go**: it stays where you dropped it and
     everything stops moving in about a fifth of a second. Hold one still
     without letting go: everything settles around it rather than drifting;
   - drag one cluster off to a corner: it is left there, because moving a note
     by hand switches off the pull towards the middle. **Tidy** puts the
     automatic layout back;
   - untick **hover details** if the hover card is in the way; hovering still
     highlights a note's neighbours;
   - close the panel and reopen it: same layout, no animation at all;
   - type in the filter box: notes that do not match disappear rather than fade;
   - **double-click** a node to open it - a single drag must never open one.

## Then try it yourself

Put the cursor anywhere and press `Ctrl+Alt+M`. Write a first line (that
becomes the title), type `[[` to reference one of the seeded notes and `#` to
reuse a hashtag, then save with `Ctrl+S`. The new note appears in the list and
drops into the graph without disturbing the others.

`git status` afterwards: only `.laxative/notes.json` differs. Your source files
are never touched.

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
