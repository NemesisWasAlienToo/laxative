# Changelog

## 0.6.4

- Holding a node still no longer keeps the rest of the graph drifting. The
  layout was kept warm for as long as the mouse button was down; it is now kept
  warm by the movement itself, so a held-but-still node lets everything settle
  within about 120ms, while dragging one still pulls its neighbours along.
- Settling is faster again across the board (about 6 frames rather than 12).
- Moving a note by hand switches off the pull towards the centre of the canvas,
  which used to drag every cluster back to the middle and made it impossible to
  hold two groups apart. A **Tidy** button in the graph toolbar hands the layout
  back to the simulation when you want it arranged automatically again.
- New notes are now seeded next to the notes already on screen rather than at
  the centre of the canvas, which could be nowhere near them.
- Bigger, notched arrowheads, so which way a reference points is readable at a
  glance.
- The hover card can be turned off with a **hover details** checkbox next to the
  other two, for when it sits on top of what you are trying to see. Hovering
  still highlights a note's neighbours.

## 0.6.3

- The graph layout now cools on a fixed schedule instead of running until the
  nodes happen to slow down, so it always comes to rest in about a fifth of a
  second. Dropping a node used to leave it creeping towards the middle for
  several seconds: the centre pull never stops, so the old "has everything
  slowed down?" test for being finished stayed false while the layout crawled.
- A dragged node now stays roughly where it is dropped, and the whole opening
  layout is computed before the first frame, so nothing is ever drawn mid-slide.
- The try-it sandbox now opens with six notes already attached to its sample
  project, so the gutter markers, the reading panel, both groupings and the
  graph can all be checked at a glance instead of being typed in first. Unit
  tests check that seed against the extension's own parser, including that each
  note still sits on the line of code it talks about.

- The README now covers upgrading an installed copy, and spells out that notes
  live in the workspace and so survive an upgrade or an uninstall.

## 0.6.2

- Fixed the reading panel jumping to a new editor column each time a note was
  opened. It was revealed "beside" whatever had focus, which moved it and
  resized every other group; it now stays in the column it is already in.
- Fixed each edited note splitting the editor area again. Note editors now
  share one group, so only the first one splits.
- Revealing a note no longer drags the file into the first column when it is
  already open in another group.

## 0.6.1

- The graph no longer replays its whole layout animation every time the panel is
  reopened. Node positions, pan, zoom, filter text and the grouping checkboxes
  are kept in the view's persisted state, so reopening it from the status bar
  looks the same as switching back to its tab.
- Laying out a graph for the first time now happens before the first frame is
  drawn, instead of over several seconds of visible drift, and the simulation
  freezes once motion dies down rather than jittering forever.

## 0.6.0

- Renamed the extension to **Laxative**. Command ids, settings and the notes
  file all move from `codenotes.*` / `.codenotes/` to `laxative.*` /
  `.laxative/`; point `laxative.storeFile` at the old path to keep existing
  notes where they are.
- The reading panel's action bar scrolls horizontally on a narrow panel instead
  of wrapping or clipping actions out of reach.
- Dropped the bare `:12` beside each note in the list. Under a file group the
  file is already the parent row, so there is no description at all; grouped by
  hashtag each note shows `path:line`. The full location moved into the hover,
  spelled out.

## 0.5.0

- The reading panel's actions are a proper VS Code-style toolbar: flat icon
  buttons that light up on hover, with the destructive one held apart, instead
  of a row of coloured form buttons.
- The panel no longer prints the note's title above the note, which repeated the
  first line, and no longer lists references and backlinks: they are in the
  note's own text, the tree and the graph already.
- Graph: opening a note takes a **double click**, so dragging nodes around no
  longer opens them; filtered-out notes are hidden rather than greyed; node size
  now scales with connectedness on a curve that keeps hubs readable.
- New `laxative.listClickAction`: choose what clicking a note in the list does
  — jump to the code, open the rendered note, open its markdown, or any
  combination.
- Removed the arrow counts from the tree; they were cryptic and told nobody
  anything the graph does not show better.

## 0.4.0

- Notes now store **line and character** instead of line and a snippet of the
  annotated code. No copy of your code goes into the notes file, and revealing a
  note lands the cursor on the exact column. Notes are pinned to that position:
  they no longer follow code that moves.
- The note graph moved out of an editor tab into a **Note Graph tab in the
  bottom panel**, next to Terminal, like GitLens's commit graph.
- The CodeLens no longer carries a codicon, so a note shows exactly one icon:
  the gutter bubble.
- New **Show Rendering Diagnostics** command: each webview reports what it
  actually rendered, so a blank panel can be diagnosed instead of guessed at.
- `./docker/try-it.sh` now runs the real desktop VS Code build over noVNC.
  code-server is still available with `--web`, with a warning: its webviews need
  a service worker, which browsers refuse outside `http://localhost`/HTTPS.
- Every reload of the notes file is now race-guarded, not just watcher-driven
  ones, so a reload can never drop a note that was just created.

## 0.3.0

- Fixed a reopened note showing as blank: the reading panel now renders the
  note's real content, and registers its listener before loading the webview so
  the first render can never be missed.
- The note editor is no longer closed and reopened when you save, which looked
  like the window reloading. Tab names are settled when a note is opened
  instead: after the code while the note is empty, after the first line once it
  has been written.
- The reading panel is now a live preview: it follows the active note editor and
  re-renders as you type, before you save.
- Fixed the note graph drawing nothing when the webview was laid out after its
  script ran, which left the canvas at 0x0. Also shows an empty-state message.
- One icon per note: the gutter bubble. The end-of-line hint is now plain text.
- Default keyboard shortcuts for searching notes and for opening the note on the
  current line, alongside the existing one for adding a note.
- Webview scripts are now covered by jsdom tests, the layer where the blank
  panel and empty graph both hid.

## 0.2.0

- Notes are now edited in a real VS Code text editor (`laxative:` documents)
  instead of a one-line input box or a webview textarea: multi-line, markdown
  highlighting, normal keybindings, `Ctrl+S` to save.
- The editor tab is named after the note's first line and follows it on save.
- `[[` and `#` completions come from VS Code's own IntelliSense.
- **Configure Storage** command: shared, private (with `.gitignore` offer), or a
  custom path, moving existing notes to the new location.
- `laxative.storeFile` is `resource`-scoped; added `laxative.confirmDelete`.
- The notes file is written atomically, and a store write can no longer be
  clobbered by a file-watcher event arriving mid-write.
- A note closed without any content is discarded.

## 0.1.0

First release.

- Notes anchored to a line, stored outside the source file.
- Gutter icon, dimmed inline title, hover card with Open/Edit/Delete, CodeLens.
- Markdown bodies, rendered in a note panel with an inline editor.
- `[[note-id]]` references with `[[`-triggered autocomplete, plus backlinks.
- `#hashtag` grouping, with rules that avoid every markdown use of `#`.
- Notes view in the activity bar, grouped by file or hashtag, with tag filter.
- Force-directed note graph.
- Git-friendly `.laxative/notes.json` store, watched for external changes.
- JSON and Markdown export, JSON import with merge or replace.
- Anchors that follow their code when lines move.
