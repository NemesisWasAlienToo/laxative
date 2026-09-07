# Laxative

*It helps you digest the code.*

Attach markdown notes to places in your code **without editing the code**. Notes
live in one git-friendly JSON file, cross-reference each other, group by
hashtag, and can be browsed as a list or as a graph.



## Requirements

VS Code 1.85 or newer, and [Docker](https://docs.docker.com/get-docker/) to
build. Nothing else: no Node, no toolchain, nothing installed globally.

## Install

Not on the Marketplace yet, so build the package and install it from the file:

```bash
git clone https://github.com/OWNER/laxative.git
cd laxative
./docker/test.sh package                      # writes dist/laxative.vsix
code --install-extension dist/laxative.vsix
```

Then run **Developer: Reload Window**. `dist/` is not committed, so the package
step is what creates the `.vsix` — a fresh clone has no `dist/laxative.vsix`
until you run it. The first build downloads a VS Code image and takes a few
minutes; later ones are cached.

Prefer the UI? Extensions view → `...` → **Install from VSIX…** → pick
`dist/laxative.vsix`.

## Upgrading

```bash
git pull
./docker/test.sh package                            # rebuild dist/laxative.vsix
code --install-extension dist/laxative.vsix --force
```

Then **Developer: Reload Window** (`Ctrl+Shift+P`). VS Code loads an extension
once per window, so until you reload you are still running the old code.

`--force` is what makes this work: the version in `package.json` does not change
between local builds, and without it VS Code sees a version it already has and
does nothing. There is no need to uninstall first, and no need to close your
editor.

**Your notes are not touched by an upgrade.** They live in your workspace, in
`.laxative/notes.json` (or wherever `laxative.storeFile` points), which is a
file in your project like any other — it is not stored inside the extension.
Uninstalling the extension does not delete it either; the notes simply stop
being displayed until you install again. The same goes for your settings and
your keybindings, which live in your VS Code profile.

The one thing that does not survive is the graph's remembered layout, which is
held by the panel itself: after a reload the graph lays itself out again, which
now takes about a fifth of a second.

To check what is installed: `code --list-extensions --show-versions | grep laxative`.

**Uninstalling:** `code --uninstall-extension local.laxative`, or from the
Extensions view. Your `.laxative/notes.json` stays where it is.

## What it does

| | |
|---|---|
| **Annotate a line** | Put the cursor on a line, press `Ctrl+Alt+M` (`Cmd+Alt+M` on macOS) or run **Laxative: Add Note at Cursor**. A real markdown editor opens beside your code. Your source file is never touched. |
| **Write it** | Notes are ordinary editable documents, so you get the full VS Code editor: multi-line, markdown highlighting, your own keybindings, `Ctrl+S` to save. The editor is never closed or reopened while you type in it. |
| **Live preview** | Open the reading panel beside the editor and it renders as you type, before you save — it follows whichever note editor is active. |
| **See it** | One speech-bubble icon in the gutter, the title dimmed at the end of the line, and a CodeLens above it. Each is switchable in settings. |
| **Read / modify / remove** | Hover the line for the rendered note plus **Open · Edit · Delete** links, or click the CodeLens to open the reading panel, which carries Edit, Go to code, Copy reference and Delete actions. |
| **Markdown** | Notes are markdown, rendered in the reading panel and in the hover. |
| **Title from the first line** | Like Obsidian: whatever you write on the first line names the note, everywhere it appears. |
| **Reference other notes** | Type `[[` in the editor and VS Code's own IntelliSense offers every other note, fuzzy-searchable by title, file or id. Each note shows its outgoing references and its backlinks. |
| **Group by hashtag** | Write `#perf`, `#bug`, `#perf/hot-path` anywhere in a note; typing `#` suggests tags already in use. The Notes view can group by hashtag instead of by file, and filter to one tag. |
| **Central list** | The **Laxative** activity-bar view lists every note in the workspace, grouped by file or hashtag. What a click does is up to you — see `laxative.listClickAction`. |
| **Graph** | A **Note Graph** tab in the bottom panel, next to Terminal, the way GitLens puts its commit graph. Obsidian-style force-directed map: arrows are references, faint lines join notes sharing a file or a tag, and node size grows with how connected a note is. Drag to rearrange, **double-click to open**, filter to hide everything else. The layout is computed before the first frame and remembered, so it opens finished rather than sliding into place, and reopening the panel shows it exactly as you left it. Drag a note anywhere and it stays where you drop it, the rest making room in about a fifth of a second. |
| **Git** | Everything is stored in `.laxative/notes.json`, sorted deterministically so diffs stay small and merges stay sane. Commit it to share notes with your team, or run **Configure Storage** to keep it private. |
| **Import / export** | Export to JSON (round-trips) or Markdown (for reading); import with a merge-or-replace choice. |

## Keyboard shortcuts

| | |
|---|---|
| `Ctrl+Alt+M` / `Cmd+Alt+M` | Add a note at the cursor |
| `Ctrl+Alt+Shift+M` / `Cmd+Alt+Shift+M` | Search notes |
| `Ctrl+Alt+J` / `Cmd+Alt+J` | Open the note on the current line |

Rebind any of them in **File → Preferences → Keyboard Shortcuts** (`Ctrl+K Ctrl+S`)
by searching for `Laxative`. Every command is bindable, not just these three.

## The editor tab's name

A note's editor is a document like any other, so its tab name is fixed while it
is open — VS Code would have to close and reopen the tab to rename it, which is
disruptive mid-sentence. So:

- a new, empty note is named after the code it annotates (`cache.ts-15.md`);
- once it has content, reopening it names the tab after its first line.

The list, the graph, the hover and the reading panel always show the live title.

## How a note is anchored

A note stores the file, the **line** and the **character** the cursor was on
when you made it, and nothing else about your code — no copy of the annotated
line ends up in the notes file. Revealing a note puts the cursor back on that
exact line and column (clamped if the line has since become shorter).

This means notes are pinned to a position: if you insert lines above one, it
stays on its old line number rather than following the code. Making notes chase
their code would mean storing a snippet of the anchored line to search for,
which puts a copy of your source into the notes file — a trade-off this
deliberately does not make.

## Hashtags vs. markdown

`#` is busy in markdown, so a `#` only starts a tag when it is followed
immediately by a letter and is not preceded by a word character, `#`, `/`, `&`,
`(` or `\`, and is outside fenced or inline code. In practice this means all of
the following are **not** tags:

```
# Heading          ### Heading        (headings need a space, so they are safe)
#123               closes #123        (issue references)
[jump](#section)   https://x/y#frag   (anchors and url fragments)
&#160;             \#literal          (entities and escapes)
`#define`          ``` … #x … ```     (inline and fenced code)
#a1b2c3                               (6- and 8-digit hex colours)
```

Everything else — `#perf`, `#tech-debt`, `#perf/hot-path` — is a tag. Tags are
lower-cased, and they are always derived from the note body, so the stored file
can never drift out of sync with what you wrote.

## Where notes are stored

`laxative.storeFile` decides, and **Laxative: Configure Storage** (also the
gear in the Notes view toolbar) sets it with a guided prompt:

| Choice | File | |
|---|---|---|
| Shared with the team | `.laxative/notes.json` | Commit it; everyone sees the same notes. |
| Private to me | `.laxative/notes.local.json` | Offers to add it to `.gitignore`. |
| Custom path... | anything relative to the workspace | Validated to stay inside the workspace. |

Changing it offers to move your existing notes to the new location. The setting
is `resource`-scoped, so a `.vscode/settings.json` can pin it per project. Notes
are written atomically (write beside, then rename), so a crash or a concurrent
reader never sees a half-written file.

## Storage format

`.laxative/notes.json`, relative to the first workspace folder (configurable
via `laxative.storeFile`):

```json
{
  "version": 1,
  "notes": [
    {
      "id": "k3f9a2mx",
      "title": "Race with the cache warmer",
      "body": "Race with the cache warmer\n\nSee [[p1x8dd02|the retry note]]. #bug #perf",
      "file": "src/cache.ts",
      "line": 14,
      "character": 4,
      "tags": ["bug", "perf"],
      "createdAt": "2026-09-04T10:00:00.000Z",
      "updatedAt": "2026-09-04T10:00:00.000Z"
    }
  ]
}
```

Notes are sorted by file, then line, then character, then id, so two people annotating different
files produce diffs that merge instead of conflicting. The file is watched, so a
`git checkout` or `git pull` refreshes the view immediately.

## Commands

All are under the **Laxative:** prefix in the command palette.

`Add Note at Cursor` · `Show Notes at Cursor` · `Search Notes` ·
`Group Notes by Hashtag` / `by File` · `Filter Notes by Hashtag...` ·
`Clear Hashtag Filter` · `Show Note Graph` · `Configure Storage...` ·
`Export Notes...` · `Import Notes...` · `Open Notes Store File` ·
`Show Rendering Diagnostics` · `Refresh Notes`

## Settings

| Setting | Default | |
|---|---|---|
| `laxative.storeFile` | `.laxative/notes.json` | Where notes are stored, relative to the workspace. See above. |
| `laxative.listClickAction` | `["reveal", "preview"]` | What clicking a note in the Notes view does: any combination of `reveal` (jump to the code), `preview` (open the rendered note) and `edit` (open its markdown). An empty list makes clicking do nothing. |
| `laxative.showGutterIcon` | `true` | Speech-bubble icon in the gutter. |
| `laxative.showInlineTitle` | `true` | Dimmed title at the end of the annotated line. |
| `laxative.showCodeLens` | `true` | Clickable CodeLens above the annotated line. |
| `laxative.confirmDelete` | `true` | Ask before deleting a note. |

## Building and testing

Everything runs in Docker — no Node, no VS Code, and no extension is installed
on your machine.

```bash
./docker/test.sh            # typecheck + unit tests + integration tests + package
./docker/test.sh unit       # fast loop: typecheck and unit tests
./docker/test.sh integration# headless VS Code (xvfb) driving the real extension
./docker/test.sh package    # writes dist/laxative.vsix
```

The image carries its own `node_modules`, so no `node_modules/` directory is
ever created in this repo; the source is bind-mounted read-only and copied into
a scratch dir inside the container. Downloaded VS Code builds are cached in the
`laxative-vscode-cache` docker volume.

### Trying it by hand

```bash
./docker/try-it.sh          # real VS Code -> http://localhost:8443/vnc.html
./docker/try-it.sh --web    # code-server  -> http://localhost:8443
```

The default runs the **real desktop VS Code build** — the same one the tests use
— on a virtual display, reachable in your browser over noVNC, with the extension
installed and a sample git project to annotate. The sample comes with six notes
already attached, chosen so every visual is on screen at once — three files, a
well-connected hub note, an untagged one, a nested tag, a code fence to render
and one deliberately dangling reference — and its README is a short checklist of
what to look at. Nothing stops you adding your own on top. Nothing is written outside a
temp directory and your local VS Code is untouched. `Ctrl+C` stops and deletes
the sandbox.

**Why not code-server by default:** it serves webviews through a service worker,
which browsers only allow on `http://localhost` or over HTTPS. Opened by LAN
address or through a proxy, every webview goes blank — including VS Code's own
markdown preview for a plain `.md` file. If you see that, it is the environment,
not this extension. **Laxative: Show Rendering Diagnostics** reports what each
webview actually put on screen.

## Known limits

- VS Code has no API for clicking a gutter icon, so the gutter bubble is a
  marker — use the hover or the CodeLens to open a note.
- An editor tab keeps the name it was opened with; see above.
- Notes anchor to lines in the **first** workspace folder of a multi-root
  workspace.
- Markdown export is for reading; import accepts the JSON format only.
- A note opened and closed without typing anything is discarded, so an
  accidental `Ctrl+Alt+M` leaves nothing behind.

## License

MIT — see [LICENSE](LICENSE).
