// @ts-check
// Small force-directed layout: repulsion between all nodes, springs along
// references, and a weak pull toward the centre. No external libraries.
(function () {
  const vscode = acquireVsCodeApi();
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
  const ctx = canvas.getContext('2d');
  const tip = document.getElementById('tip');
  const filterInput = /** @type {HTMLInputElement} */ (document.getElementById('filter'));
  const excludeInput = /** @type {HTMLInputElement} */ (document.getElementById('exclude'));
  const showFiles = /** @type {HTMLInputElement} */ (document.getElementById('showFiles'));
  const showTags = /** @type {HTMLInputElement} */ (document.getElementById('showTags'));
  const showTip = /** @type {HTMLInputElement} */ (document.getElementById('showTip'));
  const tidy = /** @type {HTMLButtonElement} */ (document.getElementById('tidy'));
  const openReveals = /** @type {HTMLInputElement} */ (document.getElementById('openReveals'));
  const linkPull = /** @type {HTMLInputElement} */ (document.getElementById('linkPull'));
  const openNote = /** @type {HTMLInputElement} */ (document.getElementById('openNote'));
  const options = /** @type {HTMLElement} */ (document.getElementById('options'));
  const nodeMenu = /** @type {HTMLElement} */ (document.getElementById('nodeMenu'));
  const stats = document.getElementById('stats');
  const groupByMark = /** @type {HTMLInputElement} */ (document.getElementById('groupByMark'));
  const groupByPath = /** @type {HTMLInputElement} */ (document.getElementById('groupByPath'));
  const expandAll = /** @type {HTMLButtonElement} */ (document.getElementById('expandAll'));
  const collapseAll = /** @type {HTMLButtonElement} */ (document.getElementById('collapseAll'));
  const groupHead = /** @type {HTMLElement} */ (document.getElementById('groupHead'));

  const PALETTE = [
    '#4ea1ff', '#f2a63b', '#5fd39a', '#e06c9f', '#b48ead',
    '#e5c07b', '#61afef', '#98c379', '#e06c75', '#56b6c2'
  ];

  /** Every note, shown or folded away inside a closed group. */
  let notes = [];
  /** Links between notes, as the notes have them. */
  let noteLinks = [];
  let noteById = new Map();
  /**
   * What is on the canvas: the notes not inside a closed group, and one bubble
   * for each closed group. Everything that moves, is drawn or is clicked works
   * on these.
   */
  let nodes = [];
  /** Links between what is on the canvas: many notes' links between the same
   *  two things are one link, with how many it stands for. */
  let edges = [];
  /**
   * Groups, by path (`auth`, `auth/login`): from the `@group` at the end of a
   * note's first line, or from the folders and file a note is on.
   */
  let groups = new Map();
  /** 'mark' (@group), 'path' (folder and file) or 'none'. */
  let groupMode = 'mark';
  /** Which groups you opened or closed, by mode and path; kept per person, in
   *  the view's own state, never in the notes. */
  let groupOpen = {};
  /** A graph this big starts with its groups closed. */
  /** Expanded groups with what is shown of them, for their outlines. */
  let openGroups = [];
  /** What sits side by side, by the open group it is in (null: the top). */
  let siblings = new Map();
  /** Room left between two groups, or a group and what is next to it. */
  const GROUP_GAP = 24;
  /** Room between an open group's outline and what is in it. */
  const GROUP_PAD = 18;
  let view = { x: 0, y: 0, scale: 1 };
  let hovered = null;
  /** The note an open menu belongs to. It stays lit while its menu is up, and
   *  nothing behind the menu is hovered by a pointer that is on the menu. */
  let menuNode = null;
  let dragging = null;
  let panning = null;
  /** Ids of the notes you have picked out. Grabbing any one of them moves the
   *  whole selection together, keeping their positions relative to each other. */
  let selected = new Set();
  /** Where the pointer was at the last drag step, so a group moves by deltas
   *  and the grabbed note keeps its offset from the pointer. */
  let dragFrom = null;
  /** A selection box being drawn, in world coordinates. */
  let marquee = null;
  /** Where a right press started and what was under it, so a press that goes
   *  nowhere opens a menu — the note's own, or the graph's — while one that
   *  moves draws a selection box. */
  let rightPressed = null;
  /** A left press on empty canvas: if it never moves, it was a click, which
   *  clears the selection the way clicking empty space does everywhere else. */
  let pressedEmpty = null;
  let query = '';
  let excluded = '';
  // Split once per keystroke rather than per node per frame.
  let queryTerms = [];
  let excludeTerms = [];
  let groupByFile = true;
  let groupByTag = true;
  /** The hover card is useful until it is sitting on top of what you want to
   *  see, so it can be switched off without losing the hover highlight. */
  let tooltips = true;
  /** What a double-click does, as two independent switches: either, both or
   *  neither. Going to the code alone is a way to browse the graph without a
   *  reading panel opening over it every time. */
  let openOnDouble = true;
  let revealOnOpen = false;
  /** Links act as springs, pulling linked notes towards each other. Off, you
   *  can put linked notes as far apart as you like and they stay there; the
   *  links are still drawn. */
  let linkTension = true;
  /** True while Tidy or a brand-new layout is being computed. Those are asking
   *  for a layout *by* the links, so they use them whatever the option says. */
  let annealing = false;
  /** The note open in front of you, ringed so it stands out in the graph. */
  let focusedId = null;
  /** True once motion has died down; the simulation then stops until something
   *  disturbs it, so a settled graph costs nothing and never jitters. */
  let settled = false;

  // Every force is scaled by `alpha`, which cools towards `alphaTarget` on a
  // fixed schedule. Convergence is then bounded by the schedule rather than by
  // how far the layout happens to have to travel: without this a node dropped
  // far from the middle crept towards it for seconds, because the centre pull
  // is constant and the old stop condition only watched for slow velocities.
  const ALPHA_MIN = 0.02;      // colder than this and the layout is done
  const ALPHA_DECAY = 0.11;    // 1 -> ALPHA_MIN in ~34 steps
  const STEPS_PER_FRAME = 6;   // so those steps take ~6 frames, not ~34
  const DRAG_ALPHA = 0.3;      // how hard the rest reacts to a node being held
  // Repulsion falls off as 1/d^2 but never reaches zero, so across a whole
  // graph the far-away notes still add up to a real outward push. With the
  // centre pull switched off -- which is what hand-arranging does -- nothing
  // balances that, and the layout expands a little more every time it is
  // disturbed. Past this range two notes simply ignore each other, which gives
  // the layout an equilibrium to settle at and lets two parked clusters be
  // genuinely independent of one another.
  const REPEL_RANGE = 320;
  const REPEL_RANGE_SQ = REPEL_RANGE * REPEL_RANGE;
  // Since notes further apart than that ignore each other, each note only has
  // to be compared with the notes in the grid cells around its own. Comparing
  // every pair was 18 million comparisons a step with 6,000 notes.
  const CELL = REPEL_RANGE;
  // In a graph bigger than this, dragging a note moves only the notes near it:
  // waking all of them for every drag made a big graph crawl, and a note on the
  // far side has no reason to move because you moved this one.
  const LOCAL_LIMIT = 400;
  const LOCAL_RADIUS = 450;
  /** ...and at most this many of them, the nearest, however crowded it is. */
  const LOCAL_MAX = 200;
  const LOCAL_RADIUS_SQ = LOCAL_RADIUS * LOCAL_RADIUS;
  /** Notes this close to the drag push on the ones that move, so they are
   *  the only ones put in the grid while dragging. */
  const NEAR_SQ = (LOCAL_RADIUS + CELL) * (LOCAL_RADIUS + CELL);
  // A frame does as many layout steps as fit in this, at least one, so a big
  // graph settles over more frames instead of stalling each one.
  const FRAME_BUDGET_MS = 6;
  // The first layout is worked out before anything is shown, up to this long;
  // a big graph then finishes settling on screen instead of keeping you
  // waiting on a blank panel.
  const BURN_IN_BUDGET_MS = 1000;
  // New notes arriving in numbers are laid out on a spiral this far apart,
  // sized to how many there are, rather than piled on one small circle.
  const SPIRAL_SPACING = 45;
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  // File and hashtag links are dotted only while that is cheap: past this many
  // dots on screen they are drawn as plain faint lines...
  const MANY_DOTS = 3000;
  // ...and past this many of them on screen (a big graph, zoomed right out),
  // not at all: thousands of faint lines are a grey haze that costs more to
  // draw than everything else together. Links between notes always show.
  const MANY_GROUP_LINKS = 2000;
  // An arrow head: its length, and the angle each side makes with the link.
  const HEAD = 12;
  const HEAD_COS = Math.cos(0.52);
  const HEAD_SIN = Math.sin(0.52);
  // ...and, once you have arranged the graph yourself, each note is held
  // gently at the spot it last came to rest in. That is what replaces the pull
  // towards the middle: the layout keeps its shape and its size wherever you
  // have put it, instead of either creeping back to the centre or drifting
  // apart, while still being free to move locally when something changes.
  const HOME_PULL = 0.03;
  /** How hard an open group pulls what is in it towards its middle. */
  const GROUP_PULL = 0.004;
  /** Room per note in an open group: it is kept within about
   *  GROUP_SPACING × √(what is in it) of its middle. */
  const GROUP_SPACING = 26;
  let alpha = 0;
  let alphaTarget = 0;
  /** True when every node came back from a previous session at its old spot. */
  let restoredLayout = false;
  /** Set the moment you move a note by hand. The pull towards the middle is
   *  what stops an automatic layout wandering off screen, but it also means a
   *  cluster parked to one side creeps back, so hand-arranging switches it off
   *  and the arrangement is left alone. Tidy puts it back. */
  let arranged = false;
  let saveTimer = null;
  /** The note being dragged in a big graph: only notes near it move, until
   *  the layout comes to rest again. Null means every note is free to move. */
  let localCentre = null;
  /** False until the first notes arrive, so an empty canvas says it is
   *  loading rather than that there are no notes. */
  let received = false;

  // The view is torn down and rebuilt whenever its panel is closed and
  // reopened, so the layout is kept in the webview's own persisted state.
  // Without this every reopen re-ran the whole animation from scratch.
  const STATE_VERSION = 2;

  function loadState() {
    const saved = vscode.getState();
    return saved && saved.v === STATE_VERSION ? saved : null;
  }

  function saveState() {
    syncGroups();
    const positions = {};
    for (const node of notes) {
      positions[node.id] = [Math.round(node.x * 10) / 10, Math.round(node.y * 10) / 10];
    }
    vscode.setState({
      v: STATE_VERSION,
      positions,
      view: { x: view.x, y: view.y, scale: view.scale },
      query,
      excluded,
      groupByFile,
      groupByTag,
      tooltips,
      openOnDouble,
      revealOnOpen,
      linkTension,
      arranged,
      // Notes put somewhere by hand: their links no longer pull them away.
      placed: notes.filter((node) => node.placed).map((node) => node.id),
      groupMode,
      groupOpen
    });
  }

  function saveStateSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 250);
  }

  /**
   * Records where the notes belong. Deliberately *not* done every time the
   * layout stops: if home followed each settle, a nudge outwards would become
   * the new home and the next nudge would start from there, so the graph would
   * ratchet itself apart. Home moves only when you move a note, or when the
   * automatic layout has just decided the whole arrangement.
   */
  function anchor() {
    for (const node of nodes) {
      node.hx = node.x;
      node.hy = node.y;
    }
  }

  // ---- Groups -------------------------------------------------------------

  /** The group path a note is in, under the current way of grouping. */
  function groupKeyOf(note) {
    if (groupMode === 'mark') {
      return note.group || null;
    }
    if (groupMode === 'path') {
      return note.file || null;
    }
    return null;
  }

  function isOpen(group) {
    const saved = groupOpen[groupMode + ':' + group.path];
    // Closed until opened: a group is one bubble at first.
    return saved === true;
  }

  function setOpen(group, open) {
    groupOpen[groupMode + ':' + group.path] = open;
  }

  /**
   * Builds the group tree from the notes. Each group knows its notes, its
   * sub-groups and how many notes are in it all told. A group with a single
   * note is not worth a bubble, so it never closes: the note is just shown.
   */
  function buildGroups() {
    const previous = groups;
    groups = new Map();
    const ensure = (path) => {
      let group = groups.get(path);
      if (group) {
        return group;
      }
      const cut = path.lastIndexOf('/');
      const parent = cut > 0 ? ensure(path.slice(0, cut)) : null;
      const old = previous.get(path);
      group = {
        id: 'g:' + path,
        isGroup: true,
        path,
        name: cut > 0 ? path.slice(cut + 1) : path,
        parent,
        children: [],
        notes: [],
        total: 0,
        colour: colorFor(path),
        x: old ? old.x : 0,
        y: old ? old.y : 0,
        ox: old ? old.ox : 0,
        oy: old ? old.oy : 0,
        hx: 0,
        hy: 0,
        vx: 0,
        vy: 0,
        reach: 0,
        degree: 0,
        placed: old ? old.placed : false,
        shown: old ? old.shown : false,
        search: '@' + path.toLowerCase()
      };
      if (parent) {
        parent.children.push(group);
      }
      groups.set(path, group);
      return group;
    };
    for (const note of notes) {
      const key = groupKeyOf(note);
      note.groupChain = [];
      if (!key) {
        continue;
      }
      const leaf = ensure(key);
      leaf.notes.push(note);
      for (let g = leaf; g; g = g.parent) {
        note.groupChain.unshift(g);
        g.total++;
      }
    }
  }

  /** Every note in a group, its sub-groups' too. */
  function notesIn(group) {
    const out = [...group.notes];
    for (const child of group.children) {
      out.push(...notesIn(child));
    }
    return out;
  }

  /** Can this group be closed into a bubble: it has more than one note. */
  function foldable(group) {
    return group.total > 1;
  }

  /** What stands for a note on the canvas: the outermost closed group it is
   *  in, or the note itself. */
  function shownAs(note) {
    for (const group of note.groupChain) {
      if (foldable(group) && !isOpen(group)) {
        return group;
      }
    }
    return note;
  }

  /**
   * A bubble that moved takes its notes with it, so they are where it is when
   * it opens again. Done when needed rather than on every step: before it
   * opens, before positions are saved, before the canvas is rebuilt.
   */
  function syncGroups() {
    for (const group of groups.values()) {
      if (!group.shown) {
        continue;
      }
      const dx = group.x - group.ox;
      const dy = group.y - group.oy;
      if (dx === 0 && dy === 0) {
        continue;
      }
      for (const note of notesIn(group)) {
        note.x += dx;
        note.y += dy;
        note.hx += dx;
        note.hy += dy;
        if (group.placed) {
          note.placed = true;
        }
      }
      group.ox = group.x;
      group.oy = group.y;
    }
  }

  /** Puts a bubble where its notes are, in the middle of them. */
  function gather(group) {
    const inside = notesIn(group);
    let x = 0;
    let y = 0;
    for (const note of inside) {
      x += note.x;
      y += note.y;
    }
    group.x = group.ox = group.hx = x / Math.max(inside.length, 1);
    group.y = group.oy = group.hy = y / Math.max(inside.length, 1);
    group.vx = 0;
    group.vy = 0;
  }

  /**
   * Works out what is on the canvas from the notes and which groups are open:
   * the bodies, the links between them, and each open group's outline.
   */
  function rebuild() {
    syncGroups();
    const was = new Set(nodes.filter((n) => n.isGroup).map((n) => n.path));
    for (const group of groups.values()) {
      group.shown = false;
      group.bodies = [];
      // Whether it is open is worked out again below: a group just closed
      // must not still act as an outline (it pushed everything off where its
      // outline had been, and its bubble vanished from under you).
      group.isOpenUnit = false;
    }
    const visible = [];
    const seen = new Set();
    for (const note of notes) {
      const rep = shownAs(note);
      if (seen.has(rep)) {
        continue;
      }
      seen.add(rep);
      visible.push(rep);
    }
    for (const body of visible) {
      if (body.isGroup) {
        body.shown = true;
        if (!was.has(body.path)) {
          gather(body);
        }
        body.reach = radiusOf(body);
      }
      // Each open group it is inside holds it within its outline.
      const chain = body.isGroup ? ancestors(body) : body.groupChain;
      for (const group of chain) {
        if (group !== body && foldable(group) && isOpen(group)) {
          group.bodies.push(body);
        }
      }
    }
    nodes = visible;
    // Innermost first: an outline goes round the outlines inside it, so those
    // are worked out before it.
    openGroups = [...groups.values()]
      .filter((g) => g.bodies.length > 1)
      .sort((a, b) => ancestors(b).length - ancestors(a).length);

    // What sits side by side: at the top, and inside each open group, its
    // notes, bubbles and open groups. Those are kept from overlapping.
    const openSet = new Set(openGroups);
    const deepestOpen = (chain) => {
      for (let i = chain.length - 1; i >= 0; i--) {
        if (openSet.has(chain[i])) return chain[i];
      }
      return null;
    };
    siblings = new Map();
    const add = (container, unit) => {
      const list = siblings.get(container);
      if (list) list.push(unit);
      else siblings.set(container, [unit]);
    };
    for (const group of openGroups) {
      group.isOpenUnit = true;
      add(deepestOpen(ancestors(group).slice(0, -1)), group);
    }
    for (const body of visible) {
      body.box = deepestOpen(body.isGroup ? ancestors(body).slice(0, -1) : body.groupChain);
      add(body.box, body);
    }

    // Links: between what each end is shown as, one per pair, counted.
    const byPair = new Map();
    for (const link of noteLinks) {
      const from = shownAs(link.from);
      const to = shownAs(link.to);
      if (from === to) {
        continue; // inside one closed group
      }
      const key = from.id + '\n' + to.id;
      const known = byPair.get(key);
      if (known) {
        known.count++;
      } else {
        byPair.set(key, { from, to, kind: 'ref', count: 1 });
      }
    }
    edges = [...byPair.values()];
    for (const group of groups.values()) {
      group.degree = 0;
    }
    for (const edge of edges) {
      if (edge.from.isGroup) edge.from.degree++;
      if (edge.to.isGroup) edge.to.degree++;
    }
    groupEdgeCache = null;
    const ids = new Set(nodes.map((n) => n.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    if (hovered && !ids.has(hovered.id)) {
      hovered = null;
    }
    updateStats();
  }

  /** The group, its parent, and so on up. */
  function ancestors(group) {
    const out = [];
    for (let g = group; g; g = g.parent) {
      out.unshift(g);
    }
    return out;
  }

  /** Opens or closes a group, and redraws what is on the canvas to match. */
  function toggleGroup(group, open, deep) {
    syncGroups();
    if (!open) {
      // Closing: the bubble goes where the group's notes are now.
      setOpen(group, false);
      gather(group);
      group.placed = false;
    } else {
      setOpen(group, true);
    }
    if (deep) {
      const walk = (g) => {
        for (const child of g.children) {
          setOpen(child, open);
          walk(child);
        }
      };
      walk(group);
    }
    const before = new Set(openGroups);
    rebuild();
    compactOpened(before);
    unsettle(0.3);
    saveStateSoon();
  }

  /** Opens or closes every group. */
  function setAllGroups(open) {
    syncGroups();
    for (const group of groups.values()) {
      setOpen(group, open);
    }
    const before = new Set(openGroups);
    rebuild();
    compactOpened(before);
    unsettle(0.3);
    saveStateSoon();
  }

  /**
   * A group just opened lays out what is in it close together round where
   * its bubble was, unless it is already that tight (as you left it). The
   * innermost first, so each sub-group is in one piece before its parent
   * places it.
   */
  function compactOpened(before) {
    const opened = openGroups
      .filter((g) => !before.has(g))
      .sort((a, b) => ancestors(b).length - ancestors(a).length);
    for (const group of opened) {
      const units = siblings.get(group) || [];
      if (units.length < 2) {
        continue;
      }
      for (const unit of units) {
        if (unit.isOpenUnit) circleOf(unit);
      }
      const ux = (u) => (u.isOpenUnit ? u.cx : u.x);
      const uy = (u) => (u.isOpenUnit ? u.cy : u.y);
      const ur = (u) => (u.isOpenUnit ? u.cr : radiusOf(u));
      let cx = 0;
      let cy = 0;
      for (const unit of units) {
        cx += ux(unit);
        cy += uy(unit);
      }
      cx /= units.length;
      cy /= units.length;
      let spread = 0;
      for (const unit of units) {
        spread = Math.max(spread, Math.hypot(ux(unit) - cx, uy(unit) - cy));
      }
      if (spread <= GROUP_SPACING * Math.sqrt(units.length) * 1.3) {
        continue;
      }
      // A sunflower: even spacing, the biggest in the middle.
      const order = [...units].sort((a, b) => ur(b) - ur(a));
      // Even spacing for notes; anything bigger is pushed clear by separate().
      const room = GROUP_SPACING;
      order.forEach((unit, i) => {
        const r = room * Math.sqrt(i + 0.5);
        const a = i * 2.39996;
        const dx = cx + Math.cos(a) * r - ux(unit);
        const dy = cy + Math.sin(a) * r - uy(unit);
        for (const body of unit.isOpenUnit ? unit.bodies : [unit]) {
          body.x += dx;
          body.y += dy;
          body.hx = body.x;
          body.hy = body.y;
          body.vx = 0;
          body.vy = 0;
        }
      });
    }
  }

  /** The innermost open group whose outline is around a point. */
  function outlineAt(point) {
    let best = null;
    for (const outline of outlines) {
      const d = Math.hypot(point.x - outline.x, point.y - outline.y);
      if (d <= outline.r && (!best || outline.r < best.r)) {
        best = outline;
      }
    }
    return best;
  }

  /** The open group whose name, written on its outline, is under a point. */
  function outlineLabelAt(point) {
    for (const outline of outlines) {
      const lx = outline.x;
      const ly = outline.y - outline.r;
      const half = (outline.labelWidth || 40) / 2 + 6;
      if (Math.abs(point.x - lx) <= half && point.y >= ly - 16 / view.scale - 4 && point.y <= ly + 6) {
        return outline;
      }
    }
    return null;
  }

  /** Outlines of the open groups as last drawn: where they are, how big. */
  let outlines = [];

  /** Something changed: warm the layout back up so it re-settles, then stops. */
  function unsettle(warmth) {
    alpha = Math.max(alpha, warmth === undefined ? 0.5 : warmth);
    alphaTarget = 0;
    settled = false;
  }

  /** A note attached to nothing has no file to take a colour from. */
  const NO_FILE_COLOUR = '#8c8c8c';

  function colorFor(file) {
    if (!file) {
      return NO_FILE_COLOUR;
    }
    let hash = 0;
    for (let i = 0; i < file.length; i++) {
      hash = (hash * 31 + file.charCodeAt(i)) >>> 0;
    }
    return PALETTE[hash % PALETTE.length];
  }

  /**
   * Keeps the drawing buffer matched to the element. Called every frame because
   * a webview often lays out after its script has already run, which would
   * otherwise leave a 0x0 canvas that draws nothing forever.
   */
  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(Math.floor(canvas.clientWidth * ratio), 1);
    const height = Math.max(Math.floor(canvas.clientHeight * ratio), 1);
    if (canvas.width === width && canvas.height === height) {
      return false;
    }
    canvas.width = width;
    canvas.height = height;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return true;
  }

  function setGraph(payload) {
    const saved = loadState();
    syncGroups();
    const previous = new Map(notes.map((n) => [n.id, n]));
    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 600;
    // A note that has just changed group goes to its new group, wherever that
    // is, rather than staying where it was.
    const regrouped = (n) => {
      const old = previous.get(n.id);
      return old !== undefined && groupKeyOf(old) !== groupKeyOf(n);
    };
    const knownAt = (n) =>
      regrouped(n) ? undefined : previous.get(n.id) || (saved && saved.positions && saved.positions[n.id]);
    const known = payload.nodes
      .map(knownAt)
      .filter(Boolean)
      .map((n) => (Array.isArray(n) ? n : [n.x, n.y]));
    const seed = known.length
      ? [
          known.reduce((sum, p) => sum + p[0], 0) / known.length,
          known.reduce((sum, p) => sum + p[1], 0) / known.length
        ]
      : [width / 2, height / 2];
    received = true;
    let placed = 0;
    // A few new notes go on a ring around the others; many at once go on a
    // spiral that grows with their number, so they start spread out instead
    // of thousands deep on one small circle. New notes in a group start next
    // to the rest of their group (see below).
    const fresh = payload.nodes.length - known.length;
    let freshIndex = 0;
    const groupSeat = seatsByGroup(payload.nodes, knownAt, seed);
    noteLinks = [];
    notes = payload.nodes.map((n, i) => {
      const old = regrouped(n) ? undefined : previous.get(n.id);
      const remembered = !regrouped(n) && saved && saved.positions && saved.positions[n.id];
      const angle = (i / Math.max(payload.nodes.length, 1)) * Math.PI * 2;
      let x;
      let y;
      if (old) {
        ({ x, y } = old);
        placed++;
      } else if (remembered) {
        [x, y] = remembered;
        placed++;
      } else if (groupSeat.has(n.id)) {
        [x, y] = groupSeat.get(n.id);
      } else if (fresh > 50) {
        const k = freshIndex++;
        const r = SPIRAL_SPACING * Math.sqrt(k + 0.5);
        x = seed[0] + Math.cos(k * GOLDEN_ANGLE) * r;
        y = seed[1] + Math.sin(k * GOLDEN_ANGLE) * r;
      } else {
        x = seed[0] + Math.cos(angle) * 160 + (Math.random() - 0.5) * 40;
        y = seed[1] + Math.sin(angle) * 160 + (Math.random() - 0.5) * 40;
      }
      // Everything a filter looks at, lower-cased once here: this is read for
      // every node on every frame, so it must not be built on every frame.
      const search = [
        n.title,
        n.excerpt,
        n.file || '',
        n.group ? '@' + n.group : '',
        ...(n.tags || []).map((t) => '#' + t)
      ]
        .join('\n')
        .toLowerCase();
      // Its colour, worked out once rather than on every frame.
      const colour = colorFor(n.file);
      const placedByHand = old
        ? old.placed === true
        : !!(saved && Array.isArray(saved.placed) && saved.placed.includes(n.id));
      return {
        ...n,
        search,
        colour,
        placed: placedByHand,
        x,
        y,
        hx: x,
        hy: y,
        vx: 0,
        vy: 0,
        degree: 0,
        reach: 0,
        groupChain: []
      };
    });
    const byId = new Map(notes.map((n) => [n.id, n]));
    noteById = byId;
    for (const edge of payload.edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (from && to) {
        noteLinks.push({ from, to, kind: 'ref' });
        from.degree++;
        to.degree++;
      }
    }
    buildGroups();
    rebuild();
    restoredLayout = notes.length > 0 && placed === notes.length;
    if (restoredLayout) {
      // Every note is where it was left: show that, do not animate to it.
      rest();
      anchor();
    } else {
      // A layout with some notes already placed only needs room made for the
      // new ones, so it starts warm rather than hot and barely disturbs the
      // notes you had arranged.
      burnIn(placed > 0 ? 0.5 : 1, placed === 0);
    }
    saveStateSoon();
    groupEdgeCache = null;
    focusedId = payload.focus || null;
    // A note that was deleted cannot stay selected.
    selected = new Set(nodes.filter((n) => selected.has(n.id)).map((n) => n.id));
    updateStats();
  }

  /**
   * Where new notes in a group start: next to the notes of their group that
   * are already placed, or, for a group with none yet, at a spot of the
   * group's own, on a spiral of groups around the middle. Within a group they
   * lie on a small spiral, sub-groups next to each other. So a group opened
   * for the first time shows its notes together, not scattered over the
   * whole graph.
   */
  function seatsByGroup(payloadNodes, knownAt, seed) {
    const seats = new Map();
    if (groupMode === 'none') {
      return seats;
    }
    const clusters = new Map(); // top-level path -> { known: [x,y][], fresh: [] }
    for (const n of payloadNodes) {
      const key = groupKeyOf(n);
      if (!key) {
        continue;
      }
      const top = key.split('/')[0];
      let cluster = clusters.get(top);
      if (!cluster) {
        clusters.set(top, (cluster = { known: [], fresh: [] }));
      }
      const at = knownAt(n);
      if (at) {
        cluster.known.push(Array.isArray(at) ? at : [at.x, at.y]);
      } else {
        cluster.fresh.push({ n, key });
      }
    }
    let placedSoFar = 0;
    let k = 0;
    for (const [, cluster] of [...clusters].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (cluster.fresh.length === 0) {
        continue;
      }
      let centre;
      if (cluster.known.length > 0) {
        centre = [
          cluster.known.reduce((s, p) => s + p[0], 0) / cluster.known.length,
          cluster.known.reduce((s, p) => s + p[1], 0) / cluster.known.length
        ];
      } else {
        // Area for each group in proportion to its size, so big groups do
        // not overlap their neighbours.
        const size = cluster.fresh.length;
        const r = SPIRAL_SPACING * 1.6 * Math.sqrt(placedSoFar + size / 2 + 4);
        centre = [seed[0] + Math.cos(k * GOLDEN_ANGLE) * r, seed[1] + Math.sin(k * GOLDEN_ANGLE) * r];
        placedSoFar += size;
        k++;
      }
      cluster.fresh.sort((a, b) => a.key.localeCompare(b.key));
      const start = cluster.known.length;
      cluster.fresh.forEach(({ n }, i) => {
        const j = start + i;
        const r = SPIRAL_SPACING * 0.8 * Math.sqrt(j + 0.5);
        seats.set(n.id, [centre[0] + Math.cos(j * GOLDEN_ANGLE) * r, centre[1] + Math.sin(j * GOLDEN_ANGLE) * r]);
      });
    }
    return seats;
  }

  /** Stops the simulation dead: no residual velocity, no lingering drift. */
  function rest() {
    for (const node of nodes) {
      node.vx = 0;
      node.vy = 0;
    }
    alpha = 0;
    alphaTarget = 0;
    settled = true;
    localCentre = null;
  }

  /**
   * Runs the whole anneal without drawing, so the first frame the user sees is
   * a finished layout at rest rather than one crawling into place. Held hot for
   * the first stretch to spread the notes out, then cooled to a stop. The
   * budget is capped against the O(n^2) repulsion so even a large graph stays
   * well inside a single frame.
   */
  function burnIn(warmth, structural) {
    const count = Math.max(nodes.length, 1);
    const budget = Math.max(60, Math.min(600, Math.floor(400000 / (count * count))));
    const hot = Math.floor(budget * 0.6);
    annealing = structural === true;
    alpha = warmth;
    alphaTarget = warmth;
    settled = false;
    const started = performance.now();
    for (let i = 0; i < budget && !settled; i++) {
      if (i === hot) {
        alphaTarget = 0;
      }
      step();
      if (performance.now() - started > BURN_IN_BUDGET_MS) {
        // Out of time: show it now and let it finish settling on screen.
        alphaTarget = 0;
        annealing = false;
        anchor();
        return;
      }
    }
    rest();
    anchor();
    annealing = false;
  }

  /**
   * Faint links between notes that share a file or a hashtag. Asked for by the
   * physics and by the drawing on every frame they run, so it is built once and
   * kept until the notes or the two grouping options change.
   */
  let groupEdgeCache = null;
  /** Links and grouping links together, built along with the grouping ones. */
  let allEdges = [];
  function linksAndGroups() {
    groupEdges();
    return allEdges;
  }
  function groupEdges() {
    if (groupEdgeCache) {
      return groupEdgeCache;
    }
    const extra = [];
    // Between what each note is shown as: notes inside one closed group need
    // no link, and a closed group needs one link to anything, not one per note.
    const seen = new Set();
    const chain = (sets, kind) => {
      for (const set of sets.values()) {
        for (let i = 1; i < set.length; i++) {
          const from = shownAs(set[i - 1]);
          const to = shownAs(set[i]);
          if (from === to) {
            continue;
          }
          const key = kind + '\n' + from.id + '\n' + to.id;
          if (!seen.has(key)) {
            seen.add(key);
            extra.push({ from, to, kind });
          }
        }
      }
    };
    if (groupByFile) {
      const byFile = new Map();
      for (const node of notes) {
        if (!node.file) {
          continue; // Nothing to share a file with.
        }
        byFile.set(node.file, [...(byFile.get(node.file) || []), node]);
      }
      chain(byFile, 'file');
    }
    if (groupByTag) {
      const byTag = new Map();
      for (const node of notes) {
        for (const tag of node.tags || []) {
          byTag.set(tag, [...(byTag.get(tag) || []), node]);
        }
      }
      chain(byTag, 'tag');
    }
    groupEdgeCache = extra;
    allEdges = edges.concat(extra);
    return extra;
  }

  function step() {
    if (settled) {
      return;
    }
    // Holding a node keeps the layout warm, so grabbing one is also how you
    // wake a settled graph up and let it rearrange itself around where you are
    // putting things. It cools to a stop as soon as you let go.
    if (dragging) {
      alpha = Math.max(alpha, DRAG_ALPHA);
    }
    alpha += (alphaTarget - alpha) * ALPHA_DECAY;
    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 600;

    // Which notes move this step: all of them, or in a big graph being
    // dragged, only those near the note in your hand.
    let moving = nodes;
    let near = nodes;
    if (localCentre) {
      moving = [];
      near = [];
      for (const node of nodes) {
        const dx = node.x - localCentre.x;
        const dy = node.y - localCentre.y;
        node.distanceSq = dx * dx + dy * dy;
        node.free = false;
        if (node.distanceSq < LOCAL_RADIUS_SQ) {
          moving.push(node);
        }
        if (node.distanceSq < NEAR_SQ) {
          near.push(node);
        }
      }
      // A crowded graph has hundreds of notes in reach; the nearest move.
      if (moving.length > LOCAL_MAX) {
        moving.sort((a, b) => a.distanceSq - b.distanceSq);
        moving.length = LOCAL_MAX;
      }
      for (const node of moving) {
        node.free = true;
      }
    } else {
      for (const node of nodes) {
        node.free = true;
      }
    }

    repel(moving, near);

    for (const edge of linkTension || annealing ? linksAndGroups() : []) {
      if (!edge.from.free && !edge.to.free) {
        continue;
      }
      const dx = edge.to.x - edge.from.x;
      const dy = edge.to.y - edge.from.y;
      const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const restLength = edge.kind === 'ref' ? 130 : 90;
      const stiffness = edge.kind === 'ref' ? 0.02 : 0.008;
      const force = (distance - restLength) * stiffness * alpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      // A note you put somewhere yourself stays there: its links pull the
      // notes at their other end, not it. Otherwise a note dragged out of the
      // crowd was yanked hundreds of pixels back towards it, by links
      // stretched across the whole graph, whenever anything near it moved.
      // A bubble has the links of all its notes: each pulls it only a share,
      // or closing a group sent the bubble off towards whatever it links to.
      if (!edge.from.placed) {
        const share = edge.from.isGroup ? 1 / Math.max(edge.from.degree, 1) : 1;
        edge.from.vx += fx * share;
        edge.from.vy += fy * share;
      }
      if (!edge.to.placed) {
        const share = edge.to.isGroup ? 1 / Math.max(edge.to.degree, 1) : 1;
        edge.to.vx -= fx * share;
        edge.to.vy -= fy * share;
      }
    }

    // Each open group holds what is in it together, so its outline goes round
    // a group rather than round half the graph. Hand-placed notes stay put.
    for (const group of openGroups) {
      const bodies = group.bodies;
      let cx = 0;
      let cy = 0;
      for (const body of bodies) {
        cx += body.x;
        cy += body.y;
      }
      cx /= bodies.length;
      cy /= bodies.length;
      // Past its size, pulled back hard: links to other groups do not
      // stretch it across the graph.
      const limit = GROUP_SPACING * Math.sqrt(bodies.length) + 10;
      for (const body of bodies) {
        if (body.free && !body.placed) {
          const dx = cx - body.x;
          const dy = cy - body.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          const over = d > limit ? ((d - limit) / d) * 0.3 : 0;
          body.vx += dx * (GROUP_PULL + over) * alpha;
          body.vy += dy * (GROUP_PULL + over) * alpha;
        }
      }
    }

    for (const node of moving) {
      if (arranged) {
        node.vx += (node.hx - node.x) * HOME_PULL * alpha;
        node.vy += (node.hy - node.y) * HOME_PULL * alpha;
      } else {
        node.vx += (width / 2 - node.x) * 0.0015 * alpha;
        node.vy += (height / 2 - node.y) * 0.0015 * alpha;
      }
      if (isHeld(node)) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= 0.86;
      node.vy *= 0.86;
      node.x += Math.max(Math.min(node.vx, 12), -12);
      node.y += Math.max(Math.min(node.vy, 12), -12);
    }

    separate();

    // Cold enough to be finished, or nothing to simulate: stop outright. The
    // schedule decides this, so settling always takes the same short time
    // whatever the layout was doing. This applies while a node is still held,
    // too: holding one still is not a reason to keep the others drifting, and
    // moving it warms the layout straight back up.
    if (alpha <= ALPHA_MIN || nodes.length === 0) {
      rest();
      saveStateSoon();
    }
  }

  /** The circle round what is shown of an open group. */
  function circleOf(group) {
    let cx = 0;
    let cy = 0;
    for (const body of group.bodies) {
      cx += body.x;
      cy += body.y;
    }
    cx /= group.bodies.length;
    cy /= group.bodies.length;
    let r = 0;
    for (const body of group.bodies) {
      r = Math.max(r, Math.hypot(body.x - cx, body.y - cy) + radiusOf(body));
    }
    r += GROUP_PAD;
    // Round the outlines of the open groups inside it, too.
    for (const unit of siblings.get(group) || []) {
      if (unit.isOpenUnit) {
        r = Math.max(r, Math.hypot(unit.cx - cx, unit.cy - cy) + unit.cr + GROUP_PAD / 2);
      }
    }
    group.cx = cx;
    group.cy = cy;
    group.cr = r;
  }

  /**
   * Keeps open groups and bubbles from overlapping what sits beside them:
   * another group, a bubble, or a note that is not in the group. An open
   * group moves as one piece, all its notes together, so it keeps its shape;
   * the one in your hand stays put and the others make room, the way notes
   * make room for a note. Positions are corrected directly, homes with them,
   * so nothing pulls a group back into the one it was pushed out of.
   */
  function separate() {
    if (openGroups.length === 0 && !nodes.some((n) => n.isGroup)) {
      return;
    }
    for (const group of openGroups) {
      circleOf(group);
      group.held = false;
    }
    if (dragging) {
      for (const body of held) {
        for (const group of body.isGroup ? ancestors(body) : body.groupChain) {
          group.held = true;
        }
      }
    }
    const x = (u) => (u.isOpenUnit ? u.cx : u.x);
    const y = (u) => (u.isOpenUnit ? u.cy : u.y);
    const r = (u) => (u.isOpenUnit ? u.cr : radiusOf(u));
    const big = (u) => u.isOpenUnit || u.isGroup;
    const fixed = (u) => (u.isOpenUnit ? u.held : isHeld(u));
    const shift = (u, dx, dy) => {
      for (const body of u.isOpenUnit ? u.bodies : [u]) {
        body.x += dx;
        body.y += dy;
        body.hx += dx;
        body.hy += dy;
      }
      if (u.isOpenUnit) {
        u.cx += dx;
        u.cy += dy;
      }
    };
    for (const list of siblings.values()) {
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!big(a)) {
          continue;
        }
        for (let j = 0; j < list.length; j++) {
          const b = list[j];
          // Each pair once: a big one against small ones anywhere, and
          // against big ones after it.
          if (j === i || (big(b) && j < i)) {
            continue;
          }
          let dx = x(b) - x(a);
          let dy = y(b) - y(a);
          let d = Math.sqrt(dx * dx + dy * dy);
          const overlap = r(a) + r(b) + (big(b) ? GROUP_GAP : GROUP_GAP / 2) - d;
          if (overlap <= 0) {
            continue;
          }
          if (d < 0.01) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d = Math.hypot(dx, dy);
          }
          const ux = dx / d;
          const uy = dy / d;
          const fa = fixed(a);
          const fb = fixed(b);
          if (fa && fb) {
            continue;
          }
          // Half the overlap each step: settled in a few steps, no jolt.
          const step = overlap * 0.5;
          const shareA = fa ? 0 : fb ? 1 : 0.5;
          shift(a, -ux * step * shareA, -uy * step * shareA);
          shift(b, ux * step * (1 - shareA), uy * step * (1 - shareA));
        }
      }
    }
  }

  /**
   * The part of the line from (ax, ay) to (bx, by) inside the rectangle, as
   * [x0, y0, x1, y1], or null when none of it is (Liang-Barsky).
   */
  function clip(ax, ay, bx, by, left, top, right, bottom) {
    const dx = bx - ax;
    const dy = by - ay;
    let t0 = 0;
    let t1 = 1;
    // The four sides in turn, written out: this runs for links crossing the
    // edge of the screen, every frame, so it allocates nothing.
    const ps = [-dx, dx, -dy, dy];
    const qs = [ax - left, right - ax, ay - top, bottom - ay];
    for (let i = 0; i < 4; i++) {
      const p = ps[i];
      const q = qs[i];
      if (p === 0) {
        if (q < 0) return null;
        continue;
      }
      const t = q / p;
      if (p < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
    return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
  }

  /** The grid cell a position falls in, as one number for a Map key. */
  function cellOf(x, y) {
    return (Math.floor(x / CELL) + 50000) * 100000 + (Math.floor(y / CELL) + 50000);
  }

  /** Pushes two notes apart, `a` the other way from `b`. Both, or only `a`. */
  function push(a, b, both) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let distanceSq = dx * dx + dy * dy;
    if (distanceSq > REPEL_RANGE_SQ) {
      return;
    }
    if (distanceSq < 0.01) {
      dx = Math.random() - 0.5;
      dy = Math.random() - 0.5;
      distanceSq = 0.01;
    }
    const distance = Math.sqrt(distanceSq);
    let force = (9000 / distanceSq) * alpha;
    // A bubble pushes a little harder than a note, for its size. Keeping
    // things off it altogether is separate (see separate()), and the same for
    // bubbles and open groups.
    const reach = a.reach + b.reach;
    if (reach > 0) {
      force *= 1 + reach / 60;
    }
    // Notes in the same open group sit closer together.
    if (a.box && a.box === b.box) {
      force *= 0.35;
    }
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    a.vx -= fx;
    a.vy -= fy;
    if (both) {
      b.vx += fx;
      b.vy += fy;
    }
  }

  /**
   * Notes push each other apart, out to REPEL_RANGE and no further, so each
   * note is only compared with the notes in its own and the neighbouring grid
   * cells: the same forces as comparing every pair, at a fraction of the work.
   */
  function repel(moving, near) {
    const grid = new Map();
    for (const node of near) {
      const key = cellOf(node.x, node.y);
      const cell = grid.get(key);
      if (cell) {
        cell.push(node);
      } else {
        grid.set(key, [node]);
      }
    }
    if (moving !== nodes) {
      // Only some notes move: each is pushed by everything near it, moving or
      // not, and pushes back on nothing (what does not move ignores forces).
      for (const a of moving) {
        const cx = Math.floor(a.x / CELL);
        const cy = Math.floor(a.y / CELL);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const cell = grid.get((cx + ox + 50000) * 100000 + (cy + oy + 50000));
            if (!cell) {
              continue;
            }
            for (const b of cell) {
              if (b !== a) {
                push(a, b, false);
              }
            }
          }
        }
      }
      return;
    }
    // Everything moves: each pair once, looking only at the cells to one side
    // (right, and the row below) so no pair is counted twice.
    for (const [key, cell] of grid) {
      for (let i = 0; i < cell.length; i++) {
        for (let j = i + 1; j < cell.length; j++) {
          push(cell[i], cell[j], true);
        }
      }
      for (const offset of [100000 - 1, 100000, 100000 + 1, 1]) {
        const other = grid.get(key + offset);
        if (!other) {
          continue;
        }
        for (const a of cell) {
          for (const b of other) {
            push(a, b, true);
          }
        }
      }
    }
  }

  /** Well-connected notes read as bigger hubs, with a curve that keeps the
   *  difference visible without letting one note dominate. */
  function radiusOf(node) {
    if (node.isGroup) {
      // A bubble grows with how many notes are in it, within reason.
      return Math.min(14 + Math.sqrt(node.total) * 3.2, 70);
    }
    // Worked out once per note when the notes arrive: asked for several times
    // a frame for every note.
    if (node.radius === undefined || node.radiusFor !== node.degree) {
      node.radius = 5.5 + Math.sqrt(node.degree) * 3.6;
      node.radiusFor = node.degree;
    }
    return node.radius;
  }

  /** Search terms in a box, the same way the search view splits them. */
  function terms(text) {
    return text
      .split(/[\s,]+/)
      .map((term) => term.trim().toLowerCase())
      .filter((term) => term.length > 0);
  }

  // Mirrors src/core/search.ts: every filter term has to appear, and any
  // exclude term hides the note outright.
  function isMatch(node) {
    if (queryTerms.length === 0 && excludeTerms.length === 0) {
      return true;
    }
    if (node.isGroup) {
      return matchCount(node) > 0;
    }
    const text = node.search;
    if (excludeTerms.some((term) => text.includes(term))) {
      return false;
    }
    return queryTerms.every((term) => text.includes(term));
  }

  /** How many of a group's notes the filter lets through. A closed group stays
   *  on screen while any of them do, and says how many. Worked out once per
   *  filter, not once per frame. */
  function matchCount(group) {
    const key = query + '\n' + excluded;
    if (group.matchKey !== key) {
      group.matchKey = key;
      group.matches = notesIn(group).filter(isMatch).length;
    }
    return group.matches;
  }

  /** Filtered-out notes are hidden outright, not greyed: an edge is only drawn
   *  when both of its ends are still on screen. */
  function visibleEdge(edge) {
    return isMatch(edge.from) && isMatch(edge.to);
  }

  /**
   * The colours the drawing borrows from the theme. `getComputedStyle` forces a
   * style recalculation, so it is asked once and again only when VS Code
   * restyles the page, rather than once per frame.
   */
  let theme = null;
  function readTheme() {
    const style = getComputedStyle(document.body);
    theme = {
      foreground: style.color || '#ccc',
      background: style.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e',
      focus: style.getPropertyValue('--vscode-focusBorder').trim() || '#3794ff',
      selection:
        style.getPropertyValue('--vscode-editor-selectionBackground').trim() ||
        'rgba(38, 79, 120, 0.8)'
    };
  }

  function draw() {
    if (!theme) {
      readTheme();
    }
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (notes.length === 0) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = theme.foreground;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        received ? 'No notes yet. Add one with Laxative: Add Note at Cursor.' : 'Loading notes…',
        canvas.clientWidth / 2,
        canvas.clientHeight / 2
      );
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);

    const foreground = theme.foreground;
    const focusColour = theme.focus;
    const selectionColour = theme.selection;
    const neighbours = new Set();
    if (hovered) {
      neighbours.add(hovered.id);
      for (const edge of edges) {
        if (edge.from === hovered) neighbours.add(edge.to.id);
        if (edge.to === hovered) neighbours.add(edge.from.id);
      }
    }

    // What is on screen, in graph coordinates, with a margin for labels and
    // halos: anything wholly outside it is not drawn at all.
    const margin = 40 / view.scale + 20;
    const left = -view.x / view.scale - margin;
    const top = -view.y / view.scale - margin;
    const right = (canvas.clientWidth - view.x) / view.scale + margin;
    const bottom = (canvas.clientHeight - view.y) / view.scale + margin;
    const onScreen = (node) =>
      node.x >= left && node.x <= right && node.y >= top && node.y <= bottom;

    // Each open group's outline, round what is shown of it, under everything
    // else. Worked out every frame: what is in it moves.
    outlines = [];
    const outlineOf = new Map();
    for (const group of openGroups) {
      let cx = 0;
      let cy = 0;
      let count = 0;
      for (const body of group.bodies) {
        if (isMatch(body)) {
          cx += body.x;
          cy += body.y;
          count++;
        }
      }
      if (count < 2) {
        continue;
      }
      cx /= count;
      cy /= count;
      let r = 0;
      for (const body of group.bodies) {
        if (isMatch(body)) {
          r = Math.max(r, Math.hypot(body.x - cx, body.y - cy) + radiusOf(body) + GROUP_PAD);
        }
      }
      // Round the outlines inside it (worked out already: innermost first).
      for (const unit of siblings.get(group) || []) {
        const inner = unit.isOpenUnit && outlineOf.get(unit);
        if (inner) {
          r = Math.max(r, Math.hypot(inner.x - cx, inner.y - cy) + inner.r + GROUP_PAD / 2);
        }
      }
      const outline = { group, x: cx, y: cy, r };
      outlineOf.set(group, outline);
      outlines.push(outline);
    }
    // Drawn outermost first, so the ones inside are on top.
    for (let i = outlines.length - 1; i >= 0; i--) {
      const outline = outlines[i];
      if (outline.x + outline.r < left || outline.x - outline.r > right || outline.y + outline.r < top || outline.y - outline.r > bottom) {
        continue;
      }
      const lit =
        (hovered && !hovered.isGroup && hovered.groupChain.includes(outline.group)) ||
        (dragging && outline.group.held);
      ctx.globalAlpha = lit ? 0.09 : 0.05;
      ctx.fillStyle = outline.group.colour;
      ctx.beginPath();
      ctx.arc(outline.x, outline.y, outline.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = lit ? 0.75 : 0.45;
      ctx.strokeStyle = outline.group.colour;
      // A plain line: a dashed one is drawn dash by dash, and round a big
      // group that is thousands of dashes every frame of a drag.
      ctx.lineWidth = 1 / view.scale;
      ctx.stroke();
      // Its name on the top of the outline, readable at any zoom: grab it to
      // move the whole group, double-click it (or inside) to close it.
      const size = 12 / view.scale;
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      const label = '@' + outline.group.name + '  ' + outline.group.total;
      const width = ctx.measureText(label).width;
      outline.labelWidth = width;
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.background;
      ctx.fillRect(outline.x - width / 2 - 4 / view.scale, outline.y - outline.r - size * 0.8, width + 8 / view.scale, size * 1.3);
      ctx.globalAlpha = lit ? 1 : 0.8;
      ctx.fillStyle = outline.group.colour;
      ctx.textAlign = 'center';
      ctx.fillText(label, outline.x, outline.y - outline.r + size * 0.3);
    }

    // Edges are drawn in batches, one stroke per look (kind, and lit or not),
    // rather than one stroke each: thousands of strokes a frame is what made
    // a big graph slow to draw.
    const KINDS = ['ref', 'file', 'tag'];
    const batches = KINDS.map(() => [[], []]); // [kind][lit] -> edges
    const heads = { lit: [], dim: [] };
    /** Links standing for several, to or from a closed group: thicker, with
     *  their count. Few, so drawn one by one. */
    const heavy = [];
    for (const edge of linksAndGroups()) {
      const a = edge.from;
      const b = edge.to;
      if (
        (a.x < left && b.x < left) ||
        (a.x > right && b.x > right) ||
        (a.y < top && b.y < top) ||
        (a.y > bottom && b.y > bottom) ||
        !visibleEdge(edge)
      ) {
        continue;
      }
      // Only the part on screen is drawn. A dotted line is drawn dot by dot
      // along its whole length, off screen too, and links cross the whole
      // graph: zoomed in, a few hundred of them made every frame slow.
      // Wholly on screen, which zoomed out is nearly all of them: drawn as
      // it is, with no clipping worked out and nothing new allocated.
      const inside = onScreen(a) && onScreen(b);
      const segment = inside ? edge : clip(a.x, a.y, b.x, b.y, left, top, right, bottom);
      if (!segment) {
        continue;
      }
      const active = !hovered || a === hovered || b === hovered;
      if (edge.count > 1) {
        heavy.push({ edge, segment, active });
        if (onScreen(b)) {
          (active ? heads.lit : heads.dim).push(edge);
        }
        continue;
      }
      batches[KINDS.indexOf(edge.kind)][active ? 1 : 0].push(segment);
      if (edge.kind === 'ref' && onScreen(b)) {
        (active ? heads.lit : heads.dim).push(edge);
      }
    }
    const groupLinks = batches[1][0].length + batches[1][1].length + batches[2][0].length + batches[2][1].length;
    KINDS.forEach((kind, k) => {
      [0, 1].forEach((lit) => {
        const batch = batches[k][lit];
        if (batch.length === 0) {
          return;
        }
        if (kind !== 'ref' && groupLinks > MANY_GROUP_LINKS && !(hovered && lit === 1)) {
          return; // Too many to be worth drawing; the hovered note's still show.
        }
        const active = lit === 1;
        ctx.strokeStyle = foreground;
        ctx.globalAlpha = kind === 'ref' ? (active ? 0.6 : 0.12) : active ? 0.16 : 0.05;
        // One screen pixel wide at every zoom. The canvas draws lines of a
        // pixel or less on a fast path; anything thicker goes the slow way,
        // and zoomed in, links 1.4 or 2 pixels wide made a frame take 25 ms
        // with only a handful of notes on screen. Links between notes are a
        // little stronger instead of thicker.
        ctx.lineWidth = 1 / view.scale;
        // Dots and dashes a fixed number of screen pixels apart whatever the
        // zoom; and with hundreds of these links on screen, plain faint lines:
        // each dot is drawn on its own, and at that density they read as
        // lines anyway.
        const unit = 1 / view.scale;
        // How many dots that would be: the batch's length on screen, one dot
        // (or dash) every 5 pixels.
        let length = 0;
        if (kind !== 'ref') {
          for (const segment of batch) {
            length += segment.from
              ? Math.abs(segment.to.x - segment.from.x) + Math.abs(segment.to.y - segment.from.y)
              : Math.abs(segment[2] - segment[0]) + Math.abs(segment[3] - segment[1]);
          }
        }
        const plain = kind === 'ref' || (length * view.scale) / 5 > MANY_DOTS;
        ctx.setLineDash(plain ? [] : kind === 'tag' ? [unit, 4 * unit] : [3 * unit, 4 * unit]);
        ctx.beginPath();
        for (const segment of batch) {
          if (segment.from) {
            ctx.moveTo(segment.from.x, segment.from.y);
            ctx.lineTo(segment.to.x, segment.to.y);
          } else {
            ctx.moveTo(segment[0], segment[1]);
            ctx.lineTo(segment[2], segment[3]);
          }
        }
        ctx.stroke();
      });
    });
    ctx.setLineDash([]);
    for (const { edge, segment, active } of heavy) {
      ctx.strokeStyle = foreground;
      ctx.globalAlpha = edge.kind === 'ref' ? (active ? 0.6 : 0.14) : active ? 0.2 : 0.07;
      ctx.lineWidth = Math.min(1 + Math.log2(edge.count) * 1.3, 7) / view.scale;
      ctx.beginPath();
      if (segment.from) {
        ctx.moveTo(segment.from.x, segment.from.y);
        ctx.lineTo(segment.to.x, segment.to.y);
      } else {
        ctx.moveTo(segment[0], segment[1]);
        ctx.lineTo(segment[2], segment[3]);
      }
      ctx.stroke();
    }
    // Arrow heads, stopped at the target's edge. Big enough and blunt enough
    // to read which way a link points at a glance: a long thin head reads as
    // more line, not as a direction.
    // Zoomed right out, a head is a couple of pixels: too small to show a
    // direction, and thousands of them cost more than the links themselves.
    // Drawn once they are big enough to read, or when there are few.
    const headsReadable = HEAD * view.scale >= 4 || heads.dim.length + heads.lit.length < 500;
    for (const [list, alphaOf] of [[heads.dim, 0.2], [heads.lit, 0.85]]) {
      if (list.length === 0 || !headsReadable) {
        continue;
      }
      ctx.globalAlpha = alphaOf;
      ctx.fillStyle = foreground;
      ctx.beginPath();
      for (const edge of list) {
        const dx = edge.to.x - edge.from.x;
        const dy = edge.to.y - edge.from.y;
        const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
        // Along the link, and across it: the head's corners from these alone,
        // with no trigonometry for each of thousands of links every frame.
        const ux = dx / distance;
        const uy = dy / distance;
        const r = radiusOf(edge.to) + 3;
        const tipX = edge.to.x - ux * r;
        const tipY = edge.to.y - uy * r;
        const back = HEAD * HEAD_COS;
        const side = HEAD * HEAD_SIN;
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - ux * back + uy * side, tipY - uy * back - ux * side);
        // Notched at the back, so overlapping heads stay separable.
        ctx.lineTo(tipX - ux * HEAD * 0.7, tipY - uy * HEAD * 0.7);
        ctx.lineTo(tipX - ux * back - uy * side, tipY - uy * back + ux * side);
        ctx.closePath();
      }
      ctx.fill();
    }
    ctx.setLineDash([]);

    // Notes are filled in batches too, one fill per colour (and dimmed or
    // not), with the halos, rings and labels drawn over them afterwards.
    const shown = [];
    /** Closed groups: few, and each drawn on its own. */
    const bubbles = [];
    const fills = new Map();
    for (const node of nodes) {
      if (!isMatch(node) || !onScreen(node)) {
        continue;
      }
      shown.push(node);
      if (node.isGroup) {
        bubbles.push(node);
        continue;
      }
      const dimmed = hovered && !neighbours.has(node.id);
      let pair = fills.get(node.colour);
      if (!pair) {
        fills.set(node.colour, (pair = [[], []]));
      }
      pair[dimmed ? 1 : 0].push(node);
    }
    const circle = (node, r) => {
      ctx.moveTo(node.x + r, node.y);
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    };

    // A halo behind a selected note in the editor's selection colour: reads as
    // "selected" at a glance and stays distinct from the focus ring.
    const halos = shown.filter((node) => selected.has(node.id));
    if (halos.length > 0) {
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = selectionColour;
      ctx.beginPath();
      for (const node of halos) {
        circle(node, radiusOf(node) + 7);
      }
      ctx.fill();
    }
    for (const [colour, pair] of fills) {
      pair.forEach((batch, dimmed) => {
        if (batch.length === 0) {
          return;
        }
        ctx.globalAlpha = dimmed ? 0.25 : 1;
        ctx.fillStyle = colour;
        ctx.beginPath();
        for (const node of batch) {
          circle(node, radiusOf(node));
        }
        ctx.fill();
      });
    }
    // A closed group: a soft disc in its colour with a solid edge, how many
    // notes are in it in the middle, and its name underneath.
    for (const bubble of bubbles) {
      const r = radiusOf(bubble);
      const dimmed = hovered && !neighbours.has(bubble.id);
      ctx.globalAlpha = dimmed ? 0.1 : 0.28;
      ctx.fillStyle = bubble.colour;
      ctx.beginPath();
      ctx.arc(bubble.x, bubble.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = dimmed ? 0.3 : 0.95;
      ctx.strokeStyle = bubble.colour;
      ctx.lineWidth = 2 / view.scale;
      ctx.stroke();
      if (bubble.children.length > 0) {
        // Groups inside: a second ring just inside the first.
        ctx.globalAlpha = dimmed ? 0.2 : 0.5;
        ctx.lineWidth = 1 / view.scale;
        ctx.beginPath();
        ctx.arc(bubble.x, bubble.y, r - 4 / view.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
      const filtered = queryTerms.length > 0 || excludeTerms.length > 0;
      const count = filtered ? `${matchCount(bubble)}/${bubble.total}` : String(bubble.total);
      const countSize = Math.max(Math.min(r * 0.6, 20), 10 / view.scale);
      ctx.globalAlpha = dimmed ? 0.35 : 1;
      ctx.fillStyle = foreground;
      ctx.textAlign = 'center';
      ctx.font = `600 ${countSize}px system-ui, sans-serif`;
      ctx.fillText(count, bubble.x, bubble.y + countSize * 0.35);
      const nameSize = Math.max(12, 11 / view.scale);
      ctx.font = `600 ${nameSize}px system-ui, sans-serif`;
      ctx.fillText('@' + bubble.name, bubble.x, bubble.y + r + nameSize + 2);
    }
    if (hovered && shown.includes(hovered)) {
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = foreground;
      ctx.beginPath();
      circle(hovered, radiusOf(hovered));
      ctx.stroke();
    }
    // The open note, or the closed group it is folded into.
    const focusedNote = focusedId ? noteById.get(focusedId) : undefined;
    const focusedAs = focusedNote ? shownAs(focusedNote) : undefined;
    const focusedNode = focusedAs && shown.includes(focusedAs) ? focusedAs : undefined;
    if (focusedNode) {
      // A ring with a gap, in the theme's focus colour: the same cue VS Code
      // uses for "this is the one with focus", and it survives dimming.
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(focusedNode.x, focusedNode.y, radiusOf(focusedNode) + 4, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = focusColour;
      ctx.stroke();
    }
    ctx.fillStyle = foreground;
    ctx.textAlign = 'center';
    let font = '';
    for (const node of shown) {
      if (node.isGroup) {
        continue; // named above
      }
      if (!(view.scale > 0.55 || node === hovered || node === focusedNode)) {
        continue;
      }
      const dimmed = hovered && !neighbours.has(node.id);
      ctx.globalAlpha = dimmed ? 0.3 : 0.9;
      const wanted = `${Math.min(11 + node.degree * 0.4, 15).toFixed(1)}px system-ui, sans-serif`;
      if (wanted !== font) {
        ctx.font = font = wanted;
      }
      const label = node.title.length > 28 ? node.title.slice(0, 27) + '…' : node.title;
      ctx.fillText(label, node.x, node.y + radiusOf(node) + 12);
    }
    if (marquee) {
      const box = boxOf(marquee);
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = focusColour;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = focusColour;
      ctx.lineWidth = 1 / view.scale;
      ctx.setLineDash([4 / view.scale, 3 / view.scale]);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.setLineDash([]);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * Times drawing the whole graph at each zoom level, around the middle of the
   * canvas, then puts the view back. Reading one pixel back makes the canvas
   * finish its drawing, so what is timed is the drawing and not just the
   * queueing of it. For the performance tests; nothing calls it otherwise.
   */
  function benchmark(scales) {
    const saved = { x: view.x, y: view.y, scale: view.scale };
    const cx = canvas.clientWidth / 2;
    const cy = canvas.clientHeight / 2;
    // The graph's own middle, so zooming in lands among the notes.
    const mid = nodes.length
      ? [nodes.reduce((s, n) => s + n.x, 0) / nodes.length, nodes.reduce((s, n) => s + n.y, 0) / nodes.length]
      : [0, 0];
    const results = [];
    // What reading the pixel back costs on its own, with nothing drawn.
    const empty = [];
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.getImageData(0, 0, 1, 1);
      empty.push(performance.now() - started);
    }
    empty.sort((a, b) => a - b);
    results.push({ scale: 'empty frame', ms: Math.round(empty[2] * 10) / 10, shown: 0 });
    for (const scale of scales) {
      view.scale = scale;
      view.x = cx - mid[0] * scale;
      view.y = cy - mid[1] * scale;
      const times = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        draw();
        ctx.getImageData(0, 0, 1, 1);
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      const shown = nodes.filter(
        (n) =>
          n.x * scale + view.x >= 0 && n.x * scale + view.x <= canvas.clientWidth &&
          n.y * scale + view.y >= 0 && n.y * scale + view.y <= canvas.clientHeight
      ).length;
      results.push({ scale, ms: Math.round(times[2] * 10) / 10, shown });
    }
    view = saved;
    draw();
    vscode.postMessage({ type: 'benchmark', results });
  }

  let lastReport = '';

  /**
   * Rendering is on demand. A frame is drawn when something asks for one --
   * input, a message from the extension, a resize, a theme change -- and the
   * loop keeps itself going only while the layout is still moving or a drag is
   * in progress. A graph at rest costs nothing at all, which matters more than
   * it sounds: the view is kept alive while hidden, and a loop left running
   * here is paid for by every other part of the window.
   */
  let scheduled = false;
  function wake() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(frame);
    }
  }

  function frame() {
    scheduled = false;
    if (resize() && nodes.length > 0 && !restoredLayout) {
      recentre();
      unsettle(0.4);
    }
    // Several steps a frame: the anneal is measured in steps, so this is what
    // turns a ~50-step settle into ~200ms rather than most of a second. A big
    // graph does what fits in the frame's budget, so it settles over a few
    // more frames rather than freezing on each one.
    // While a note is in your hand, one step a frame keeps the drag itself
    // smooth; the full budget comes back once it is let go.
    const started = performance.now();
    const budget = dragging && nodes.length > LOCAL_LIMIT ? 0 : FRAME_BUDGET_MS;
    for (let i = 0; i < STEPS_PER_FRAME; i++) {
      step();
      if (performance.now() - started > budget) {
        break;
      }
    }
    draw();
    report();
    if (!settled || dragging || panning || marquee) {
      wake();
    }
  }

  /** Reports what is actually on the canvas whenever that changes. */
  function report() {
    const state = `${notes.length}:${nodes.length}:${edges.length}:${canvas.width}x${canvas.height}:${focusedId}:${selected.size}`;
    if (state !== lastReport) {
      lastReport = state;
      vscode.postMessage({
        type: 'painted',
        // Every note, and what is on the canvas: notes not folded away, and
        // one bubble per closed group.
        nodes: notes.length,
        shown: nodes.length,
        groups: nodes.filter((n) => n.isGroup).map((n) => ({ path: n.path, total: n.total })),
        open: openGroups.map((g) => g.path),
        outlines: outlines.map((o) => ({ path: o.group.path, x: o.x, y: o.y, r: o.r })),
        edges: edges.length,
        width: canvas.width,
        height: canvas.height,
        focus: focusedId,
        selected: selected.size
      });
    }
  }

  /** Pulls the layout back to the middle after the canvas gets its real size. */
  function recentre() {
    if (nodes.length === 0) {
      return;
    }
    syncGroups();
    const cx = nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length;
    const cy = nodes.reduce((sum, n) => sum + n.y, 0) / nodes.length;
    const dx = canvas.clientWidth / 2 - cx;
    const dy = canvas.clientHeight / 2 - cy;
    // Notes folded into closed groups move too, and the groups with them.
    for (const node of [...notes, ...groups.values()]) {
      node.x += dx;
      node.y += dy;
      node.hx += dx;
      node.hy += dy;
      if (node.isGroup) {
        node.ox += dx;
        node.oy += dy;
      }
    }
  }

  function toWorld(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - view.x) / view.scale,
      y: (event.clientY - rect.top - view.y) / view.scale
    };
  }

  function nodeAt(point) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (
        isMatch(node) &&
        Math.hypot(node.x - point.x, node.y - point.y) <= radiusOf(node) + 6
      ) {
        return node;
      }
    }
    return null;
  }

  /** Pinned by the pointer: the grabbed note, and the rest of the selection
   *  with it when the grabbed note is part of one. */
  function isHeld(node) {
    return dragging !== null && held.has(node);
  }

  /** What a drag is moving: the grabbed note or group, the selection with it
   *  when it is part of one, or everything in an open group grabbed by its
   *  name. */
  let held = new Set();

  function boxOf(m) {
    return {
      x: Math.min(m.x0, m.x1),
      y: Math.min(m.y0, m.y1),
      w: Math.abs(m.x1 - m.x0),
      h: Math.abs(m.y1 - m.y0)
    };
  }

  function updateStats() {
    const count = selected.size;
    const closed = nodes.filter((n) => n.isGroup).length;
    stats.textContent =
      `${notes.length} notes · ` +
      (closed > 0 ? `${closed} closed group${closed === 1 ? '' : 's'} · ` : '') +
      `${noteLinks.length} links · ` +
      (count > 0 ? `${count} selected · Esc to clear` : 'right-click for options');
  }

  function select(ids) {
    selected = new Set(ids);
    updateStats();
  }

  // Right-click is the selection box, so the webview's own context menu (copy
  // and paste, with nothing to copy or paste) would only get in the way.
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('mousedown', (e) => {
    const point = toWorld(e);
    const node = nodeAt(point);
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;

    // A selection box: right-drag anywhere, or Shift+drag on empty canvas for
    // trackpads. With a modifier held it adds to what is already selected.
    if (e.button === 2 || (e.button === 0 && e.shiftKey && !node)) {
      e.preventDefault();
      if (e.button === 2) {
        rightPressed = { x: e.clientX, y: e.clientY, node };
      }
      marquee = {
        x0: point.x,
        y0: point.y,
        x1: point.x,
        y1: point.y,
        base: additive ? new Set(selected) : new Set()
      };
      return;
    }
    if (e.button !== 0) {
      return;
    }

    // An open group's name, on its outline, is its handle: the whole group
    // moves with it, so it can be taken somewhere with room and opened there.
    const label = node ? null : outlineLabelAt(point);
    if (label) {
      held = new Set(label.group.bodies);
      dragging = label.group.bodies[0];
      dragFrom = point;
      if (!arranged) {
        arranged = true;
        anchor();
      }
      if (nodes.length > LOCAL_LIMIT) {
        localCentre = dragging;
      }
      unsettle(DRAG_ALPHA);
      return;
    }

    if (node) {
      if (additive) {
        // Ctrl/Cmd/Shift+click picks a note out, or puts it back.
        if (selected.has(node.id)) {
          selected.delete(node.id);
          updateStats();
          return;
        }
        selected.add(node.id);
        updateStats();
      } else if (!selected.has(node.id)) {
        // Grabbing a note outside the selection lets the selection go, so a
        // plain drag behaves exactly as it always has.
        select([]);
      }
      dragging = node;
      held = selected.has(node.id)
        ? new Set(nodes.filter((n) => selected.has(n.id)))
        : new Set([node]);
      dragFrom = point;
      // You are arranging it yourself now, so stop pulling everything to the
      // middle and hold each note where it currently sits instead.
      if (!arranged) {
        arranged = true;
        anchor();
      }
      // A big graph: the notes around this one make room, the rest stay put.
      if (nodes.length > LOCAL_LIMIT) {
        localCentre = node;
      }
      unsettle(DRAG_ALPHA);
    } else {
      panning = { x: e.clientX - view.x, y: e.clientY - view.y };
      pressedEmpty = { x: e.clientX, y: e.clientY };
      canvas.classList.add('dragging');
    }
  });

  window.addEventListener('mousemove', (e) => {
    const point = toWorld(e);
    if (dragging) {
      const dx = point.x - dragFrom.x;
      const dy = point.y - dragFrom.y;
      dragFrom = point;
      for (const node of held) {
        node.x += dx;
        node.y += dy;
        // Where you are putting it is where it now belongs, and its links
        // stop pulling it away from there.
        node.hx = node.x;
        node.hy = node.y;
        node.placed = true;
      }
      unsettle(DRAG_ALPHA);
      return;
    }
    if (marquee) {
      marquee.x1 = point.x;
      marquee.y1 = point.y;
      const box = boxOf(marquee);
      const inside = nodes.filter(
        (n) => isMatch(n) && n.x >= box.x && n.x <= box.x + box.w && n.y >= box.y && n.y <= box.y + box.h
      );
      select([...marquee.base, ...inside.map((n) => n.id)]);
      return;
    }
    if (panning) {
      view.x = e.clientX - panning.x;
      view.y = e.clientY - panning.y;
      return;
    }
    // A menu is in front of the graph: the pointer moving across it is on the
    // menu, not on whatever the menu is covering. The note the menu is about
    // stays lit, so it is plain which note the items act on.
    const overMenu = !options.hidden || !nodeMenu.hidden;
    const node = overMenu ? menuNode : nodeAt(point);
    hovered = node;
    canvas.classList.toggle('handle', !node && !overMenu && outlineLabelAt(point) !== null);
    if (node && node.isGroup && tooltips && !overMenu) {
      tip.hidden = false;
      tip.innerHTML = '';
      const title = document.createElement('b');
      title.textContent = '@' + node.path;
      const what = document.createElement('div');
      what.className = 'where';
      const inner = node.children.length;
      what.textContent =
        `${node.total} notes` + (inner > 0 ? ` · ${inner} group${inner === 1 ? '' : 's'} inside` : '');
      const how = document.createElement('div');
      how.className = 'excerpt';
      how.textContent = 'Double-click to open. Drag to move.';
      tip.append(title, what, how);
      const rect = canvas.getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX - rect.left + 14, rect.width - 260)}px`;
      tip.style.top = `${e.clientY - rect.top + 14}px`;
    } else if (node && tooltips && !overMenu) {
      tip.hidden = false;
      tip.innerHTML = '';
      const title = document.createElement('b');
      title.textContent = node.title;
      const where = document.createElement('div');
      where.className = 'where';
      // A note whose code has gone has no line worth showing.
      where.textContent = !node.file
        ? 'no location'
        : node.lost
          ? `${node.file} · code not found`
          : `${node.file}:${node.line + 1}`;
      const excerpt = document.createElement('div');
      excerpt.className = 'excerpt';
      excerpt.textContent = node.excerpt;
      tip.append(title, where);
      if (node.group) {
        const group = document.createElement('div');
        group.className = 'where';
        group.textContent = '@' + node.group;
        tip.append(group);
      }
      if ((node.tags || []).length > 0) {
        const tags = document.createElement('div');
        tags.className = 'where';
        tags.textContent = node.tags.map((t) => '#' + t).join(' ');
        tip.append(tags);
      }
      tip.append(excerpt);
      const rect = canvas.getBoundingClientRect();
      tip.style.left = `${Math.min(e.clientX - rect.left + 14, rect.width - 260)}px`;
      tip.style.top = `${e.clientY - rect.top + 14}px`;
    } else {
      tip.hidden = true;
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (dragging || panning) {
      saveStateSoon();
    }
    // A right-click that never moved is a click for the menu, not a box.
    if (rightPressed && Math.hypot(e.clientX - rightPressed.x, e.clientY - rightPressed.y) < 4) {
      // A note's own menu when the press was on a note, the graph's options
      // when it was on the background.
      const at = { x: e.clientX, y: e.clientY };
      if (rightPressed.node && rightPressed.node.isGroup) {
        setGroupMenu(rightPressed.node, at);
      } else if (rightPressed.node) {
        setNodeMenu(rightPressed.node, at);
      } else {
        // Inside an open group, its menu leads the graph's options.
        const outline = outlineAt(toWorld(e));
        setMenu(true, at, outline ? outline.group : null);
      }
    }
    rightPressed = null;
    if (pressedEmpty && Math.hypot(e.clientX - pressedEmpty.x, e.clientY - pressedEmpty.y) < 4) {
      select([]);
    }
    dragging = null;
    held = new Set();
    dragFrom = null;
    panning = null;
    marquee = null;
    pressedEmpty = null;
    canvas.classList.remove('dragging');
  });

  // Single click selects and drags; only a double click opens the note, so
  // dragging a node around never yanks the editor open.
  canvas.addEventListener('dblclick', (e) => {
    const point = toWorld(e);
    const node = nodeAt(point);
    if (node && node.isGroup) {
      toggleGroup(node, true, false);
      return;
    }
    if (!node) {
      // Inside an open group, or on its name: close it again.
      const outline = outlineLabelAt(point) || outlineAt(point);
      if (outline) {
        toggleGroup(outline.group, false, false);
      }
      return;
    }
    if (node) {
      // Alt+double-click still goes to the code alone.
      vscode.postMessage(
        e.altKey
          ? { type: 'reveal', id: node.id }
          : { type: 'open', id: node.id, open: openOnDouble, reveal: revealOnOpen }
      );
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(Math.max(view.scale * factor, 0.2), 4);
    view.x = mx - ((mx - view.x) / view.scale) * next;
    view.y = my - ((my - view.y) / view.scale) * next;
    view.scale = next;
    saveStateSoon();
  }, { passive: false });

  // Filtering only hides nodes, so the layout does not need to move.
  filterInput.addEventListener('input', () => {
    query = filterInput.value.trim().toLowerCase();
    queryTerms = terms(query);
    saveStateSoon();
  });
  excludeInput.addEventListener('input', () => {
    excluded = excludeInput.value.trim().toLowerCase();
    excludeTerms = terms(excluded);
    saveStateSoon();
  });
  showFiles.addEventListener('change', () => {
    groupByFile = showFiles.checked;
    groupEdgeCache = null;
    unsettle(); // Grouping links are springs, so the layout has to re-settle.
    saveStateSoon();
  });
  showTags.addEventListener('change', () => {
    groupByTag = showTags.checked;
    groupEdgeCache = null;
    unsettle();
    saveStateSoon();
  });
  /** Group by @group or by folder and file: one or the other, or neither. */
  function setGroupMode(mode) {
    syncGroups();
    groupMode = mode;
    groupByMark.checked = mode === 'mark';
    groupByPath.checked = mode === 'path';
    buildGroups();
    for (const group of groups.values()) {
      group.shown = false;
    }
    nodes = nodes.filter((n) => !n.isGroup);
    rebuild();
    unsettle(0.4);
    saveStateSoon();
  }
  groupByMark.addEventListener('change', () => setGroupMode(groupByMark.checked ? 'mark' : 'none'));
  groupByPath.addEventListener('change', () => setGroupMode(groupByPath.checked ? 'path' : 'none'));
  expandAll.addEventListener('click', () => {
    closeMenus();
    setAllGroups(true);
  });
  collapseAll.addEventListener('click', () => {
    closeMenus();
    setAllGroups(false);
  });

  tidy.addEventListener('click', () => {
    // Hands the layout back to the simulation, framed in the middle again.
    arranged = false;
    for (const node of notes) {
      node.placed = false;
    }
    for (const group of groups.values()) {
      group.placed = false;
    }
    burnIn(1, true);
    recentre();
    saveStateSoon();
  });
  linkPull.addEventListener('change', () => {
    linkTension = linkPull.checked;
    if (linkTension) {
      unsettle(); // links take hold again, so let the layout respond
    }
    saveStateSoon();
  });
  openReveals.addEventListener('change', () => {
    revealOnOpen = openReveals.checked;
    saveStateSoon();
  });
  openNote.addEventListener('change', () => {
    openOnDouble = openNote.checked;
    saveStateSoon();
  });

  /** Put at the pointer, then pulled back inside the view if it would hang
   *  off the bottom or the right. */
  function place(menu, at) {
    menu.style.left = '0px';
    menu.style.top = '0px';
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - box.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - box.height - 4))}px`;
  }

  function closeMenus() {
    options.hidden = true;
    nodeMenu.hidden = true;
    menuNode = null;
  }

  /**
   * The options are the background's own context menu: right-click where there
   * is no note and they open there, the way a canvas is expected to behave.
   * Right-*drag* is still the selection box, so the menu only opens when the
   * press went nowhere.
   */
  function setMenu(open, at, group) {
    closeMenus();
    options.hidden = !open;
    if (!open) {
      return;
    }
    tip.hidden = true;
    // Right-clicked inside an open group: what can be done with that group
    // comes first.
    groupHead.textContent = '';
    groupHead.hidden = !group;
    if (group) {
      const head = document.createElement('div');
      head.className = 'head';
      head.textContent = `@${group.path} · ${group.total} notes`;
      groupHead.append(head);
      groupHead.append(menuButton('Collapse group', () => toggleGroup(group, false, false)));
      if (group.children.length > 0) {
        groupHead.append(menuButton('Collapse everything inside', () => toggleGroup(group, false, true)));
      }
      groupHead.append(document.createElement('hr'));
    }
    place(options, at);
    const first = options.querySelector('input');
    if (first) first.focus();
  }

  /** What a note's menu offers. `located` items need somewhere to go. */
  const NODE_ITEMS = [
    { label: 'Open note', command: 'laxative.openNote' },
    { label: 'Go to code', command: 'laxative.revealNote', located: true },
    { label: 'Edit note', command: 'laxative.editNote' },
    { label: 'Copy reference', command: 'laxative.copyReference' },
    { group: true },
    { separator: true },
    { label: 'Delete note', command: 'laxative.deleteNote' }
  ];

  /** A menu item that runs `action` and closes the menu. */
  function menuButton(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    // The same left column as the options' ticks, so the labels line up.
    const mark = document.createElement('span');
    mark.className = 'mark';
    button.append(mark, label);
    button.addEventListener('click', () => {
      closeMenus();
      action();
      wake();
    });
    return button;
  }

  /** The notes picked out, or just this one when it is not among them. */
  function notesToMove(node) {
    if (!selected.has(node.id)) {
      return [node.id];
    }
    return [...selected].filter((id) => noteById.has(id));
  }

  /**
   * A closed group's own menu: open it, or open everything in it, and close
   * the group it is in.
   */
  function setGroupMenu(group, at) {
    closeMenus();
    nodeMenu.hidden = false;
    menuNode = group;
    hovered = group;
    tip.hidden = true;
    nodeMenu.textContent = '';
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = `@${group.path} · ${group.total} notes`;
    nodeMenu.append(head);
    nodeMenu.append(menuButton('Expand group', () => toggleGroup(group, true, false)));
    if (group.children.length > 0) {
      nodeMenu.append(menuButton('Expand everything inside', () => toggleGroup(group, true, true)));
    }
    const parent = group.parent;
    if (parent && foldable(parent)) {
      nodeMenu.append(menuButton(`Collapse @${parent.name}`, () => toggleGroup(parent, false, false)));
    }
    place(nodeMenu, at);
    const first = nodeMenu.querySelector('button');
    if (first) first.focus();
  }

  /**
   * A note's own context menu. Right-clicking a note asks about that note —
   * open it, go to its code — and not about the graph, whose options belong to
   * the background it is drawn on.
   */
  function setNodeMenu(node, at) {
    closeMenus();
    nodeMenu.hidden = false;
    menuNode = node;
    hovered = node;
    tip.hidden = true;
    nodeMenu.textContent = '';
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = node.title;
    nodeMenu.append(head);
    for (const item of NODE_ITEMS) {
      if (item.separator) {
        nodeMenu.append(document.createElement('hr'));
        continue;
      }
      if (item.group) {
        nodeMenu.append(document.createElement('hr'));
        const ids = notesToMove(node);
        nodeMenu.append(
          menuButton(ids.length > 1 ? `Move ${ids.length} notes to group…` : 'Move to group…', () =>
            vscode.postMessage({ type: 'group', ids })
          )
        );
        // The innermost group it is shown inside, which can be closed again.
        const inside = [...node.groupChain].reverse().find((g) => foldable(g) && isOpen(g));
        if (inside) {
          nodeMenu.append(menuButton(`Collapse @${inside.name}`, () => toggleGroup(inside, false, false)));
        }
        continue;
      }
      if (item.located && !node.file) {
        continue; // a note with no location has nowhere to go
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = item.label;
      button.addEventListener('click', () => {
        closeMenus();
        vscode.postMessage({ type: 'note', command: item.command, id: node.id });
      });
      nodeMenu.append(button);
    }
    place(nodeMenu, at);
    const first = nodeMenu.querySelector('button');
    if (first) first.focus();
  }

  for (const menu of [options, nodeMenu]) {
    menu.addEventListener('mousedown', (e) => e.stopPropagation());
    menu.addEventListener('click', (e) => e.stopPropagation());
  }
  window.addEventListener('mousedown', (e) => {
    const open = [options, nodeMenu].filter((menu) => !menu.hidden);
    if (open.length > 0 && !open.some((menu) => menu.contains(/** @type {Node} */ (e.target)))) {
      closeMenus();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (!options.hidden || !nodeMenu.hidden)) {
      closeMenus();
      return;
    }
    if (e.target instanceof HTMLInputElement) {
      return; // typing in the filter box, where these keys mean text editing
    }
    if (e.key === 'Escape' && selected.size > 0) {
      select([]);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      select(nodes.filter(isMatch).map((n) => n.id));
    }
  });

  showTip.addEventListener('change', () => {
    // Nothing about the layout changes, so this does not re-settle anything.
    tooltips = showTip.checked;
    if (!tooltips) {
      tip.hidden = true;
    }
    saveStateSoon();
  });

  window.addEventListener('resize', resize);
  window.addEventListener('message', (event) => {
    if (event.data.type === 'graph') {
      setGraph(event.data);
    } else if (event.data.type === 'focus') {
      focusedId = event.data.id || null;
    } else if (event.data.type === 'benchmark') {
      benchmark(event.data.scales || []);
    } else if (event.data.type === 'groups') {
      // Driven by the tests, the same as the menu items.
      const { action, path, mode } = event.data;
      if (action === 'mode') {
        setGroupMode(mode);
      } else if (action === 'expandAll' || action === 'collapseAll') {
        setAllGroups(action === 'expandAll');
      } else if (groups.has(path)) {
        toggleGroup(groups.get(path), action === 'expand', false);
      }
      lastReport = ''; // report what is on the canvas now, even if unchanged
    }
  });

  // Restore the controls before the first graph arrives, so what comes back is
  // filtered and framed exactly as it was left.
  const startup = loadState();
  if (startup) {
    if (startup.view) {
      view = { x: startup.view.x, y: startup.view.y, scale: startup.view.scale };
    }
    query = startup.query || '';
    filterInput.value = startup.query || '';
    excluded = startup.excluded || '';
    excludeInput.value = startup.excluded || '';
    queryTerms = terms(query);
    excludeTerms = terms(excluded);
    if (typeof startup.groupByFile === 'boolean') {
      groupByFile = startup.groupByFile;
      showFiles.checked = groupByFile;
    }
    if (typeof startup.groupByTag === 'boolean') {
      groupByTag = startup.groupByTag;
      showTags.checked = groupByTag;
    }
    if (typeof startup.tooltips === 'boolean') {
      tooltips = startup.tooltips;
      showTip.checked = tooltips;
    }
    if (typeof startup.linkTension === 'boolean') {
      linkTension = startup.linkTension;
      linkPull.checked = linkTension;
    }
    if (typeof startup.openOnDouble === 'boolean') {
      openOnDouble = startup.openOnDouble;
      openNote.checked = openOnDouble;
    }
    if (typeof startup.revealOnOpen === 'boolean') {
      revealOnOpen = startup.revealOnOpen;
      openReveals.checked = revealOnOpen;
    }
    arranged = startup.arranged === true;
    if (['mark', 'path', 'none'].includes(startup.groupMode)) {
      groupMode = startup.groupMode;
    }
    if (startup.groupOpen && typeof startup.groupOpen === 'object') {
      groupOpen = startup.groupOpen;
    }
  }
  groupByMark.checked = groupMode === 'mark';
  groupByPath.checked = groupMode === 'path';

  // Anything the user does can change the picture, so any input asks for one
  // frame. Registered in the capture phase: the frame itself runs after the
  // event's own handlers have updated the state it draws.
  for (const type of ['mousedown', 'mousemove', 'mouseup', 'wheel', 'keydown', 'input', 'change', 'click']) {
    window.addEventListener(type, wake, true);
  }
  window.addEventListener('message', wake);
  window.addEventListener('resize', wake);

  // A webview is often laid out after its script has run, and a panel can be
  // resized without the window being: watch the canvas itself for its size.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(wake).observe(canvas);
  } else {
    let known = '';
    setInterval(() => {
      const size = `${canvas.clientWidth}x${canvas.clientHeight}`;
      if (size !== known) {
        known = size;
        wake();
      }
    }, 250);
  }

  // VS Code restyles the page when the colour theme changes.
  if (typeof MutationObserver !== 'undefined') {
    const restyled = new MutationObserver(() => {
      theme = null;
      wake();
    });
    restyled.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    restyled.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  }

  resize();
  wake();
  vscode.postMessage({ type: 'ready' });
})();
