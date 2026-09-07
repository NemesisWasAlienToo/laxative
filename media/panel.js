// @ts-check
// The note reading view: the rendered note, its location and its hashtags.
// Editing happens in a real VS Code text editor, which the Edit action opens.
(function () {
  const vscode = acquireVsCodeApi();
  const root = /** @type {HTMLElement} */ (document.getElementById('root'));

  /** @type {any} */
  let state = null;

  // 16px stroke icons in the style of VS Code's own, drawn inline so nothing
  // has to be fetched and no icon font has to be shipped.
  const ICONS = {
    edit: '<path d="M12.1 2.6a1.3 1.3 0 0 1 1.8 1.8L6 12.3l-2.9.7.7-2.9z"/>',
    goto: '<path d="M9.5 2.5h4v4M13.5 2.5 8 8"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/>',
    link: '<path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 1 0-3.7-3.7l-.7.8"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 1 0 3.7 3.7l.7-.8"/>',
    trash: '<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.3h4.8L11 4.5"/>'
  };

  function el(tag, props, ...children) {
    const node = Object.assign(document.createElement(tag), props || {});
    for (const child of children.flat()) {
      if (child != null) {
        node.append(child);
      }
    }
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name];
    return svg;
  }

  function action(label, iconName, onClick, extraClass) {
    const button = el('button', {
      className: `action${extraClass ? ' ' + extraClass : ''}`,
      type: 'button',
      title: label
    });
    button.setAttribute('aria-label', label);
    button.append(icon(iconName), el('span', { textContent: label }));
    button.addEventListener('click', onClick);
    return button;
  }

  /** Hashtags from the body, as chips that filter the Notes view. */
  function tagChips(tags) {
    if (!tags || tags.length === 0) {
      return null;
    }
    return el(
      'span',
      { className: 'chips' },
      tags.map((tag) => {
        const chip = el('a', { className: 'chip', textContent: `#${tag}`, href: '#' });
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'filterTag', tag });
        });
        return chip;
      })
    );
  }

  function body() {
    if (state.empty) {
      return el(
        'p',
        { className: 'empty' },
        'Nothing written yet. Press Edit to open this note in the editor; what you type is previewed here.'
      );
    }
    const rendered = el('div', { className: 'rendered' });
    rendered.innerHTML = state.html;
    // `[[ref]]` links are rewritten to laxative:<id> by the extension.
    for (const anchor of rendered.querySelectorAll('a[href^="laxative:"]')) {
      anchor.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({
          type: 'open',
          id: anchor.getAttribute('href').slice('laxative:'.length)
        });
      });
    }
    return rendered;
  }

  function render() {
    root.textContent = '';
    if (!state) {
      return;
    }
    if (state.type === 'missing') {
      root.append(el('p', { className: 'empty', textContent: 'This note has been deleted.' }));
      return;
    }

    const reveal = el('a', {
      className: 'location',
      textContent: `${state.meta.file}:${state.meta.line}:${state.meta.character}`,
      href: '#'
    });
    reveal.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({ type: 'reveal' });
    });

    root.append(
      el(
        'div',
        { className: 'toolbar', role: 'toolbar' },
        action('Edit', 'edit', () => vscode.postMessage({ type: 'edit' })),
        action('Go to code', 'goto', () => vscode.postMessage({ type: 'reveal' })),
        action('Copy reference', 'link', () => vscode.postMessage({ type: 'copyRef' })),
        el('span', { className: 'spacer' }),
        action('Delete', 'trash', () => vscode.postMessage({ type: 'delete' }), 'danger')
      ),
      // No title heading of our own: the note's first line is already the first
      // thing the rendered markdown shows, and the tab carries it too.
      el('div', { className: 'meta' }, reveal, tagChips(state.meta.tags)),
      body()
    );
  }

  window.addEventListener('message', (event) => {
    state = event.data;
    render();
    // Tells the extension what actually reached the screen, so a webview that
    // silently fails to load or render can be detected rather than guessed at.
    vscode.postMessage({
      type: 'rendered',
      bytes: root.innerHTML.length,
      empty: !!state.empty,
      title: state.note ? state.note.title : null
    });
  });

  vscode.postMessage({ type: 'ready' });
})();
