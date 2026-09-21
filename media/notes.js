// @ts-check
// The Notes list: a search box and, under it, the notes in groups. The
// extension decides what is in the list; this draws it and reports clicks.
//
// Rows are plain elements in a scrolling div, so scrolling is the browser's
// own and runs no script at all. The list is only rebuilt when it changes.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const query = /** @type {HTMLInputElement} */ ($('query'));
  const exclude = /** @type {HTMLInputElement} */ ($('exclude'));
  const excludeField = $('excludeField');
  const toggle = $('toggle');
  const summary = $('summary');
  const list = $('list');
  const empty = $('empty');

  const saved = vscode.getState() || {};
  /** Group ids the user has folded away. */
  const collapsed = new Set(Array.isArray(saved.collapsed) ? saved.collapsed : []);
  let showExclude = saved.showExclude === true;
  /** The row that is selected: a row id, or a group id. */
  let selected = typeof saved.selected === 'string' ? saved.selected : '';
  let groups = [];

  function save() {
    vscode.setState({ collapsed: [...collapsed], showExclude, selected });
  }

  // ---- icons, drawn inline so nothing has to be fetched -------------------

  const ICONS = {
    chevron: '<path d="M6 4l4 4-4 4"/>',
    note: '<path d="M2.5 3h11v8.5H7.5L4.5 14v-2.5h-2z"/>',
    file: '<path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3"/>',
    tag: '<path d="M2 2.5h5.2l6.3 6.3-5 5L2.2 7.5z"/><circle cx="5" cy="5.3" r="0.9"/>',
    untagged: '<circle cx="8" cy="8" r="4.5"/>',
    store: '<path d="M3.5 2h9v12h-9zM6 2v12M8 5.5h2.5M8 8h2.5"/>',
    reveal: '<path d="M3 8h9M8.5 4.5L12 8l-3.5 3.5"/>',
    edit: '<path d="M10.8 2.7l2.5 2.5L6 12.5l-3.2.7.7-3.2z"/>',
    filter: '<path d="M2 3h12L9.5 8.5V13l-3-1.5v-3z"/>'
  };

  function icon(name, className) {
    const holder = document.createElement('span');
    holder.className = className || 'icon';
    holder.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      `stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return holder;
  }

  /** Fonts of the file icon theme that have been handed to the browser. */
  const fontsLoaded = new Set();

  function loadFonts(fonts) {
    for (const font of fonts || []) {
      const key = `${font.id}|${font.src}`;
      if (fontsLoaded.has(key) || typeof FontFace === 'undefined') {
        continue;
      }
      fontsLoaded.add(key);
      const face = new FontFace(`laxative-icons-${font.id}`, `url("${font.src}")`, {
        weight: font.weight || 'normal',
        style: font.style || 'normal'
      });
      document.fonts.add(face);
      face.load().catch(() => undefined);
    }
  }

  /** A file's icon from the user's icon theme; a plain page when it has none. */
  function fileIcon(themed) {
    if (!themed) {
      return icon('file');
    }
    const holder = document.createElement('span');
    holder.className = 'icon themed';
    if (themed.kind === 'image') {
      const image = document.createElement('img');
      image.src = themed.src;
      image.alt = '';
      image.width = 16;
      image.height = 16;
      holder.appendChild(image);
    } else {
      holder.textContent = themed.glyph;
      holder.style.fontFamily = `"laxative-icons-${themed.font}"`;
      if (themed.color) {
        holder.style.color = themed.color;
      }
      if (themed.size) {
        holder.style.fontSize = themed.size;
      }
    }
    return holder;
  }

  function action(name, title, command) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.dataset.command = command;
    button.tabIndex = -1;
    button.appendChild(icon(name, 'glyph'));
    return button;
  }

  function text(className, value) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = value;
    return span;
  }

  // ---- drawing -------------------------------------------------------------

  function noteRow(row) {
    const el = document.createElement('div');
    el.className = 'row note';
    el.setAttribute('role', 'treeitem');
    el.setAttribute('aria-level', '2');
    el.dataset.row = row.id;
    el.dataset.note = row.noteId;
    el.title = row.tooltip;
    // The right-click menu is VS Code's own, filled from `webview/context`.
    el.dataset.vscodeContext = JSON.stringify({
      webviewSection: 'note',
      noteId: row.noteId,
      preventDefaultContextMenuItems: true
    });
    el.appendChild(icon('note'));
    el.appendChild(text('label', row.title));
    // Always there, even empty: it is what takes up the slack on the row, so
    // the buttons and the badge stay at the right edge.
    el.appendChild(text('description', row.description || ''));
    const actions = document.createElement('span');
    actions.className = 'actions';
    actions.appendChild(action('reveal', 'Go to Code', 'laxative.revealNote'));
    actions.appendChild(action('edit', 'Edit Note', 'laxative.editNote'));
    el.appendChild(actions);
    if (row.store) {
      // Which note file it is in, when more than one is switched on. Last, so
      // that the buttons appearing on hover open up beside it rather than
      // shunting it along the row.
      el.appendChild(text('store', row.store));
    }
    return el;
  }

  function groupSection(group) {
    const section = document.createElement('div');
    section.className = 'group';
    section.setAttribute('role', 'group');

    const head = document.createElement('div');
    head.className = 'row head';
    head.setAttribute('role', 'treeitem');
    head.setAttribute('aria-level', '1');
    head.dataset.row = group.id;
    head.dataset.group = group.id;
    head.dataset.vscodeContext = JSON.stringify(
      group.kind === 'tag'
        ? { webviewSection: 'tag', tag: group.tag, preventDefaultContextMenuItems: true }
        : { webviewSection: 'group', preventDefaultContextMenuItems: true }
    );
    head.appendChild(icon('chevron', 'twisty'));
    head.appendChild(group.kind === 'file' ? fileIcon(group.icon) : icon(group.kind));
    head.appendChild(text('label', group.label));
    head.appendChild(text('description', group.description));
    if (group.kind === 'tag') {
      const actions = document.createElement('span');
      actions.className = 'actions';
      const filter = action('filter', 'Show Only This Hashtag', 'laxative.filterByTag');
      filter.dataset.tag = group.tag;
      actions.appendChild(filter);
      head.appendChild(actions);
    }
    section.appendChild(head);

    const children = document.createElement('div');
    children.className = 'children';
    for (const row of group.rows) {
      children.appendChild(noteRow(row));
    }
    section.appendChild(children);
    setFolded(section, collapsed.has(group.id));
    return section;
  }

  function setFolded(section, folded) {
    section.classList.toggle('folded', folded);
    section.firstElementChild.setAttribute('aria-expanded', String(!folded));
  }

  function draw(payload) {
    groups = payload.groups;
    loadFonts(payload.fonts);
    summary.textContent = payload.summary;

    const at = list.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const group of groups) {
      fragment.appendChild(groupSection(group));
    }
    list.replaceChildren(fragment);
    list.scrollTop = at;
    mark();

    // Nothing to list at all is different from nothing matching a search.
    const nothing = payload.total === 0;
    list.hidden = nothing;
    $('boxes').hidden = nothing;
    summary.hidden = nothing;
    empty.hidden = !nothing;
    if (nothing) {
      drawEmpty(payload.hasFolder);
    }
  }

  function drawEmpty(hasFolder) {
    empty.replaceChildren();
    const say = (words) => {
      const p = document.createElement('p');
      p.textContent = words;
      empty.appendChild(p);
    };
    if (!hasFolder) {
      say('Open a folder or workspace first — notes are stored inside it.');
      return;
    }
    say('No notes yet.');
    say(
      'Put the cursor on a line of code and add a note. Notes are stored in a ' +
        'git-friendly file and never touch your source.'
    );
    for (const [label, command] of [
      ['Add note at cursor', 'laxative.addNote'],
      ['Import notes', 'laxative.import']
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'welcome';
      button.textContent = label;
      button.dataset.command = command;
      empty.appendChild(button);
    }
  }

  // ---- selection and folding ----------------------------------------------

  const rowOf = (id) =>
    /** @type {HTMLElement | null} */ (
      [...list.querySelectorAll('.row')].find((el) => /** @type {HTMLElement} */ (el).dataset.row === id) || null
    );

  /** Rows that can be reached: everything not inside a folded group. */
  function reachable() {
    return /** @type {HTMLElement[]} */ (
      [...list.querySelectorAll('.row')].filter((el) => !el.closest('.group.folded .children'))
    );
  }

  function mark() {
    for (const el of list.querySelectorAll('.row.selected')) {
      el.classList.remove('selected');
      el.removeAttribute('aria-selected');
    }
    const el = selected ? rowOf(selected) : null;
    if (el) {
      el.classList.add('selected');
      el.setAttribute('aria-selected', 'true');
    }
    return el;
  }

  function select(id, scroll) {
    selected = id;
    save();
    const el = mark();
    if (el && scroll) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  function fold(id, folded) {
    if (folded) {
      collapsed.add(id);
    } else {
      collapsed.delete(id);
    }
    const head = rowOf(id);
    if (head && head.parentElement) {
      setFolded(head.parentElement, folded);
    }
    save();
  }

  function activate(el) {
    if (el.dataset.group) {
      fold(el.dataset.group, !collapsed.has(el.dataset.group));
    } else if (el.dataset.note) {
      vscode.postMessage({ type: 'activate', noteId: el.dataset.note });
    }
  }

  /** The first row showing a note, preferring the one already selected. */
  function reveal(noteId) {
    const rows = /** @type {HTMLElement[]} */ ([...list.querySelectorAll('.row.note')]).filter(
      (el) => el.dataset.note === noteId
    );
    const el = rows.find((row) => row.dataset.row === selected) || rows[0];
    if (!el) {
      return;
    }
    const head = /** @type {HTMLElement} */ (el.closest('.group').firstElementChild);
    fold(head.dataset.group, false);
    select(el.dataset.row, true);
  }

  list.addEventListener('click', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const el = /** @type {HTMLElement | null} */ (target.closest('.row'));
    if (!el) {
      return;
    }
    select(el.dataset.row, false);
    const button = /** @type {HTMLElement | null} */ (target.closest('.action'));
    if (button) {
      vscode.postMessage({
        type: 'command',
        command: button.dataset.command,
        noteId: el.dataset.note,
        tag: button.dataset.tag
      });
      return;
    }
    activate(el);
  });

  // A right-click selects the row it is about, as lists do everywhere.
  list.addEventListener('contextmenu', (event) => {
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('.row'));
    if (el) {
      select(el.dataset.row, false);
    }
  });

  empty.addEventListener('click', (event) => {
    const button = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('.welcome'));
    if (button) {
      vscode.postMessage({ type: 'command', command: button.dataset.command });
    }
  });

  list.addEventListener('keydown', (event) => {
    const rows = reachable();
    if (rows.length === 0) {
      return;
    }
    const index = rows.findIndex((el) => el.dataset.row === selected);
    const current = index >= 0 ? rows[index] : undefined;
    let handled = true;
    if (event.key === 'ArrowDown') {
      select(rows[Math.min(index + 1, rows.length - 1)].dataset.row, true);
    } else if (event.key === 'ArrowUp') {
      select(rows[Math.max(index - 1, 0)].dataset.row, true);
    } else if (event.key === 'Home') {
      select(rows[0].dataset.row, true);
    } else if (event.key === 'End') {
      select(rows[rows.length - 1].dataset.row, true);
    } else if (event.key === 'ArrowLeft' && current) {
      if (current.dataset.group) {
        fold(current.dataset.group, true);
      } else {
        const head = /** @type {HTMLElement} */ (current.closest('.group').firstElementChild);
        select(head.dataset.row, true);
      }
    } else if (event.key === 'ArrowRight' && current && current.dataset.group) {
      fold(current.dataset.group, false);
    } else if ((event.key === 'Enter' || event.key === ' ') && current) {
      activate(current);
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
    }
  });

  // ---- the search box ------------------------------------------------------

  function setExcludeShown(shown) {
    showExclude = shown;
    excludeField.hidden = !shown;
    toggle.setAttribute('aria-expanded', String(shown));
    toggle.title = shown ? 'Hide the exclude box' : 'Show the exclude box';
    save();
  }

  function markFilled() {
    for (const input of [query, exclude]) {
      input.parentElement.classList.toggle('filled', input.value !== '');
    }
  }

  /** Sends what is in the boxes; the list below becomes the result. */
  function search() {
    markFilled();
    vscode.postMessage({ type: 'search', query: query.value, exclude: exclude.value });
  }

  toggle.addEventListener('click', () => setExcludeShown(excludeField.hidden));
  for (const input of [query, exclude]) {
    input.addEventListener('input', search);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && input.value !== '') {
        input.value = '';
        search();
      } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
        // Out of the box and into the results.
        event.preventDefault();
        list.focus();
        const rows = reachable();
        if (!rowOf(selected) && rows.length > 0) {
          select(rows[0].dataset.row, true);
        }
      }
    });
    input.parentElement.querySelector('.clear').addEventListener('click', () => {
      input.value = '';
      input.focus();
      search();
    });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'list') {
      draw(message);
    } else if (message.type === 'search') {
      // The extension set or cleared the search: show what it is searching for.
      query.value = message.query;
      exclude.value = message.exclude;
      if (message.exclude !== '') {
        setExcludeShown(true);
      }
      markFilled();
    } else if (message.type === 'reveal') {
      reveal(message.noteId);
    } else if (message.type === 'collapseAll') {
      for (const group of groups) {
        fold(group.id, true);
      }
    } else if (message.type === 'focusSearch') {
      query.focus();
      query.select();
    }
  });

  setExcludeShown(showExclude);
  vscode.postMessage({ type: 'ready' });
})();
