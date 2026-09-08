// @ts-check
// Small force-directed layout: repulsion between all nodes, springs along
// references, and a weak pull toward the centre. No external libraries.
(function () {
  const vscode = acquireVsCodeApi();
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
  const ctx = canvas.getContext('2d');
  const tip = document.getElementById('tip');
  const filterInput = /** @type {HTMLInputElement} */ (document.getElementById('filter'));
  const showFiles = /** @type {HTMLInputElement} */ (document.getElementById('showFiles'));
  const showTags = /** @type {HTMLInputElement} */ (document.getElementById('showTags'));
  const showTip = /** @type {HTMLInputElement} */ (document.getElementById('showTip'));
  const tidy = /** @type {HTMLButtonElement} */ (document.getElementById('tidy'));
  const stats = document.getElementById('stats');

  const PALETTE = [
    '#4ea1ff', '#f2a63b', '#5fd39a', '#e06c9f', '#b48ead',
    '#e5c07b', '#61afef', '#98c379', '#e06c75', '#56b6c2'
  ];

  let nodes = [];
  let edges = [];
  let view = { x: 0, y: 0, scale: 1 };
  let hovered = null;
  let dragging = null;
  let panning = null;
  let query = '';
  let groupByFile = true;
  let groupByTag = true;
  /** The hover card is useful until it is sitting on top of what you want to
   *  see, so it can be switched off without losing the hover highlight. */
  let tooltips = true;
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
  const REPEL_RANGE_SQ = 320 * 320;
  // ...and, once you have arranged the graph yourself, each note is held
  // gently at the spot it last came to rest in. That is what replaces the pull
  // towards the middle: the layout keeps its shape and its size wherever you
  // have put it, instead of either creeping back to the centre or drifting
  // apart, while still being free to move locally when something changes.
  const HOME_PULL = 0.03;
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

  // The view is torn down and rebuilt whenever its panel is closed and
  // reopened, so the layout is kept in the webview's own persisted state.
  // Without this every reopen re-ran the whole animation from scratch.
  const STATE_VERSION = 2;

  function loadState() {
    const saved = vscode.getState();
    return saved && saved.v === STATE_VERSION ? saved : null;
  }

  function saveState() {
    const positions = {};
    for (const node of nodes) {
      positions[node.id] = [Math.round(node.x * 10) / 10, Math.round(node.y * 10) / 10];
    }
    vscode.setState({
      v: STATE_VERSION,
      positions,
      view: { x: view.x, y: view.y, scale: view.scale },
      query,
      groupByFile,
      groupByTag,
      tooltips,
      arranged
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

  /** Something changed: warm the layout back up so it re-settles, then stops. */
  function unsettle(warmth) {
    alpha = Math.max(alpha, warmth === undefined ? 0.5 : warmth);
    alphaTarget = 0;
    settled = false;
  }

  function colorFor(file) {
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
    const previous = new Map(nodes.map((n) => [n.id, n]));
    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 600;
    const known = payload.nodes
      .map((n) => previous.get(n.id) || (saved && saved.positions && saved.positions[n.id]))
      .filter(Boolean)
      .map((n) => (Array.isArray(n) ? n : [n.x, n.y]));
    const seed = known.length
      ? [
          known.reduce((sum, p) => sum + p[0], 0) / known.length,
          known.reduce((sum, p) => sum + p[1], 0) / known.length
        ]
      : [width / 2, height / 2];
    let placed = 0;
    nodes = payload.nodes.map((n, i) => {
      const old = previous.get(n.id);
      const remembered = saved && saved.positions && saved.positions[n.id];
      const angle = (i / Math.max(payload.nodes.length, 1)) * Math.PI * 2;
      let x;
      let y;
      if (old) {
        ({ x, y } = old);
        placed++;
      } else if (remembered) {
        [x, y] = remembered;
        placed++;
      } else {
        x = seed[0] + Math.cos(angle) * 160 + (Math.random() - 0.5) * 40;
        y = seed[1] + Math.sin(angle) * 160 + (Math.random() - 0.5) * 40;
      }
      return { ...n, x, y, hx: x, hy: y, vx: 0, vy: 0, degree: 0 };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    edges = [];
    for (const edge of payload.edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (from && to) {
        edges.push({ from, to, kind: 'ref' });
        from.degree++;
        to.degree++;
      }
    }
    restoredLayout = nodes.length > 0 && placed === nodes.length;
    if (restoredLayout) {
      // Every note is where it was left: show that, do not animate to it.
      rest();
      anchor();
    } else {
      // A layout with some notes already placed only needs room made for the
      // new ones, so it starts warm rather than hot and barely disturbs the
      // notes you had arranged.
      burnIn(placed > 0 ? 0.5 : 1);
    }
    saveStateSoon();
    stats.textContent = `${nodes.length} notes · ${edges.length} links · double-click to open`;
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
  }

  /**
   * Runs the whole anneal without drawing, so the first frame the user sees is
   * a finished layout at rest rather than one crawling into place. Held hot for
   * the first stretch to spread the notes out, then cooled to a stop. The
   * budget is capped against the O(n^2) repulsion so even a large graph stays
   * well inside a single frame.
   */
  function burnIn(warmth) {
    const count = Math.max(nodes.length, 1);
    const budget = Math.max(60, Math.min(600, Math.floor(400000 / (count * count))));
    const hot = Math.floor(budget * 0.6);
    alpha = warmth;
    alphaTarget = warmth;
    settled = false;
    for (let i = 0; i < budget && !settled; i++) {
      if (i === hot) {
        alphaTarget = 0;
      }
      step();
    }
    rest();
    anchor();
  }

  /** Faint links between notes that share a file or a hashtag. */
  function groupEdges() {
    const extra = [];
    const chain = (groups, kind) => {
      for (const group of groups.values()) {
        for (let i = 1; i < group.length; i++) {
          extra.push({ from: group[i - 1], to: group[i], kind });
        }
      }
    };
    if (groupByFile) {
      const byFile = new Map();
      for (const node of nodes) {
        byFile.set(node.file, [...(byFile.get(node.file) || []), node]);
      }
      chain(byFile, 'file');
    }
    if (groupByTag) {
      const byTag = new Map();
      for (const node of nodes) {
        for (const tag of node.tags || []) {
          byTag.set(tag, [...(byTag.get(tag) || []), node]);
        }
      }
      chain(byTag, 'tag');
    }
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
    const springs = edges.concat(groupEdges());

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq > REPEL_RANGE_SQ) {
          continue;
        }
        if (distanceSq < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          distanceSq = 0.01;
        }
        const force = (9000 / distanceSq) * alpha;
        const distance = Math.sqrt(distanceSq);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    for (const edge of springs) {
      const dx = edge.to.x - edge.from.x;
      const dy = edge.to.y - edge.from.y;
      const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const restLength = edge.kind === 'ref' ? 130 : 90;
      const stiffness = edge.kind === 'ref' ? 0.02 : 0.008;
      const force = (distance - restLength) * stiffness * alpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      edge.from.vx += fx;
      edge.from.vy += fy;
      edge.to.vx -= fx;
      edge.to.vy -= fy;
    }

    for (const node of nodes) {
      if (arranged) {
        node.vx += (node.hx - node.x) * HOME_PULL * alpha;
        node.vy += (node.hy - node.y) * HOME_PULL * alpha;
      } else {
        node.vx += (width / 2 - node.x) * 0.0015 * alpha;
        node.vy += (height / 2 - node.y) * 0.0015 * alpha;
      }
      if (dragging === node) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= 0.86;
      node.vy *= 0.86;
      node.x += Math.max(Math.min(node.vx, 12), -12);
      node.y += Math.max(Math.min(node.vy, 12), -12);
    }

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

  /** Well-connected notes read as bigger hubs, with a curve that keeps the
   *  difference visible without letting one note dominate. */
  function radiusOf(node) {
    return 5.5 + Math.sqrt(node.degree) * 3.6;
  }

  function isMatch(node) {
    if (query === '') {
      return true;
    }
    return (
      node.title.toLowerCase().includes(query) ||
      node.file.toLowerCase().includes(query) ||
      (node.tags || []).some((tag) => ('#' + tag).includes(query)) ||
      node.excerpt.toLowerCase().includes(query)
    );
  }

  /** Filtered-out notes are hidden outright, not greyed: an edge is only drawn
   *  when both of its ends are still on screen. */
  function visibleEdge(edge) {
    return isMatch(edge.from) && isMatch(edge.to);
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    if (nodes.length === 0) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        'No notes yet. Add one with Laxative: Add Note at Cursor.',
        canvas.clientWidth / 2,
        canvas.clientHeight / 2
      );
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);

    const style = getComputedStyle(document.body);
    const foreground = style.color || '#ccc';
    const neighbours = new Set();
    if (hovered) {
      neighbours.add(hovered.id);
      for (const edge of edges) {
        if (edge.from === hovered) neighbours.add(edge.to.id);
        if (edge.to === hovered) neighbours.add(edge.from.id);
      }
    }

    for (const edge of edges.concat(groupEdges()).filter(visibleEdge)) {
      const active = !hovered || edge.from === hovered || edge.to === hovered;
      ctx.strokeStyle = foreground;
      ctx.globalAlpha = edge.kind === 'ref' ? (active ? 0.5 : 0.1) : active ? 0.16 : 0.05;
      ctx.lineWidth = edge.kind === 'ref' ? 1.4 : 1;
      ctx.setLineDash(edge.kind === 'ref' ? [] : edge.kind === 'tag' ? [1, 4] : [3, 4]);
      ctx.beginPath();
      ctx.moveTo(edge.from.x, edge.from.y);
      ctx.lineTo(edge.to.x, edge.to.y);
      ctx.stroke();

      if (edge.kind === 'ref') {
        // Arrow head, stopped at the target's edge. Big enough and blunt
        // enough to read which way a link points at a glance: a long thin
        // head reads as more line, not as a direction.
        const dx = edge.to.x - edge.from.x;
        const dy = edge.to.y - edge.from.y;
        const distance = Math.max(Math.hypot(dx, dy), 0.01);
        const r = radiusOf(edge.to) + 3;
        const tipX = edge.to.x - (dx / distance) * r;
        const tipY = edge.to.y - (dy / distance) * r;
        const angle = Math.atan2(dy, dx);
        const head = 12;
        const spread = 0.52;
        ctx.globalAlpha = active ? 0.85 : 0.2;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - head * Math.cos(angle - spread), tipY - head * Math.sin(angle - spread));
        // Notched at the back, so overlapping heads stay separable.
        ctx.lineTo(tipX - head * 0.7 * Math.cos(angle), tipY - head * 0.7 * Math.sin(angle));
        ctx.lineTo(tipX - head * Math.cos(angle + spread), tipY - head * Math.sin(angle + spread));
        ctx.closePath();
        ctx.fillStyle = foreground;
        ctx.fill();
      }
    }
    ctx.setLineDash([]);

    for (const node of nodes) {
      if (!isMatch(node)) {
        continue;
      }
      const dimmed = hovered && !neighbours.has(node.id);
      ctx.globalAlpha = dimmed ? 0.25 : 1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radiusOf(node), 0, Math.PI * 2);
      ctx.fillStyle = colorFor(node.file);
      ctx.fill();
      if (node === hovered) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = foreground;
        ctx.stroke();
      }
      if (view.scale > 0.55 || node === hovered) {
        ctx.globalAlpha = dimmed ? 0.3 : 0.9;
        ctx.fillStyle = foreground;
        ctx.font = `${Math.min(11 + node.degree * 0.4, 15).toFixed(1)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        const label = node.title.length > 28 ? node.title.slice(0, 27) + '…' : node.title;
        ctx.fillText(label, node.x, node.y + radiusOf(node) + 12);
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  let lastReport = '';

  function frame() {
    if (resize() && nodes.length > 0 && !restoredLayout) {
      recentre();
      unsettle(0.4);
    }
    // Several steps a frame: the anneal is measured in steps, so this is what
    // turns a ~50-step settle into ~200ms rather than most of a second.
    for (let i = 0; i < STEPS_PER_FRAME; i++) {
      step();
    }
    draw();
    report();
    requestAnimationFrame(frame);
  }

  /** Reports what is actually on the canvas whenever that changes. */
  function report() {
    const state = `${nodes.length}:${edges.length}:${canvas.width}x${canvas.height}`;
    if (state !== lastReport) {
      lastReport = state;
      vscode.postMessage({
        type: 'painted',
        nodes: nodes.length,
        edges: edges.length,
        width: canvas.width,
        height: canvas.height
      });
    }
  }

  /** Pulls the layout back to the middle after the canvas gets its real size. */
  function recentre() {
    const cx = nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length;
    const cy = nodes.reduce((sum, n) => sum + n.y, 0) / nodes.length;
    const dx = canvas.clientWidth / 2 - cx;
    const dy = canvas.clientHeight / 2 - cy;
    for (const node of nodes) {
      node.x += dx;
      node.y += dy;
      node.hx += dx;
      node.hy += dy;
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

  canvas.addEventListener('mousedown', (e) => {
    const point = toWorld(e);
    const node = nodeAt(point);
    if (node) {
      dragging = node;
      // You are arranging it yourself now, so stop pulling everything to the
      // middle and hold each note where it currently sits instead.
      if (!arranged) {
        arranged = true;
        anchor();
      }
      unsettle(DRAG_ALPHA);
    } else {
      panning = { x: e.clientX - view.x, y: e.clientY - view.y };
      canvas.classList.add('dragging');
    }
  });

  window.addEventListener('mousemove', (e) => {
    const point = toWorld(e);
    if (dragging) {
      dragging.x = point.x;
      dragging.y = point.y;
      // Where you are putting it is where it now belongs.
      dragging.hx = point.x;
      dragging.hy = point.y;
      unsettle(DRAG_ALPHA);
      return;
    }
    if (panning) {
      view.x = e.clientX - panning.x;
      view.y = e.clientY - panning.y;
      return;
    }
    const node = nodeAt(point);
    hovered = node;
    if (node && tooltips) {
      tip.hidden = false;
      tip.innerHTML = '';
      const title = document.createElement('b');
      title.textContent = node.title;
      const where = document.createElement('div');
      where.className = 'where';
      where.textContent = `${node.file}:${node.line + 1}`;
      const excerpt = document.createElement('div');
      excerpt.className = 'excerpt';
      excerpt.textContent = node.excerpt;
      tip.append(title, where);
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

  window.addEventListener('mouseup', () => {
    if (dragging || panning) {
      saveStateSoon();
    }
    dragging = null;
    panning = null;
    canvas.classList.remove('dragging');
  });

  // Single click selects and drags; only a double click opens the note, so
  // dragging a node around never yanks the editor open.
  canvas.addEventListener('dblclick', (e) => {
    const node = nodeAt(toWorld(e));
    if (node) {
      vscode.postMessage({ type: e.altKey ? 'reveal' : 'open', id: node.id });
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

  filterInput.addEventListener('input', () => {
    // Filtering only hides nodes, so the layout does not need to move.
    query = filterInput.value.trim().toLowerCase();
    saveStateSoon();
  });
  showFiles.addEventListener('change', () => {
    groupByFile = showFiles.checked;
    unsettle(); // Grouping links are springs, so the layout has to re-settle.
    saveStateSoon();
  });
  showTags.addEventListener('change', () => {
    groupByTag = showTags.checked;
    unsettle();
    saveStateSoon();
  });
  tidy.addEventListener('click', () => {
    // Hands the layout back to the simulation, framed in the middle again.
    arranged = false;
    burnIn(1);
    recentre();
    saveStateSoon();
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
    arranged = startup.arranged === true;
  }

  resize();
  frame();
  vscode.postMessage({ type: 'ready' });
})();
