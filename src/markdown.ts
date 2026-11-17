import MarkdownIt from 'markdown-it';
import * as vscode from 'vscode';
import { Note } from './core/types';
import { expandRefs } from './core/refs';
import { rewriteImages } from './assets';

// `html: false` keeps raw HTML out of the webview; notes are plain markdown.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

function resolver(notes: readonly Note[], href: (note: Note) => string) {
  return (id: string) => {
    const target = notes.find((n) => n.id === id);
    return target ? { href: href(target), label: target.title } : undefined;
  };
}

export function commandUri(command: string, args: unknown[]): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

// Image links are turned into something the webview can load as they are
// rendered: markdown-it has already parsed them, so this is never fooled by
// brackets in the alt text or code that looks like an image.
const renderImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet('src');
  const image = (env as { image?: (src: string) => string | undefined } | undefined)?.image;
  const resolved = src && image ? image(src) : undefined;
  if (resolved) {
    token.attrSet('src', resolved);
  }
  return renderImage(tokens, idx, options, env, self);
};

/**
 * HTML for the note webview. `[[refs]]` become `laxative:<id>` links, and each
 * image link becomes what `image` makes of it, when it makes anything.
 */
export function renderHtml(
  body: string,
  notes: readonly Note[],
  image?: (src: string) => string | undefined
): string {
  return md.render(expandRefs(body, resolver(notes, (n) => `laxative:${n.id}`)), { image });
}

/** Hover card shown on an annotated line, with working action links. */
export function hoverMarkdown(notesOnLine: readonly Note[], all: readonly Note[]): vscode.MarkdownString {
  const hover = new vscode.MarkdownString();
  hover.isTrusted = true;
  hover.supportHtml = false;
  notesOnLine.forEach((note, index) => {
    if (index > 0) {
      hover.appendMarkdown('\n\n---\n\n');
    }
    const resolve = resolver(all, (n) => commandUri('laxative.openNote', [n.id]));
    hover.appendMarkdown(`**$(comment) ${note.title}**\n\n`);
    // Images point at the files they are, from `.laxative/` or the project.
    const body = rewriteImages(note.body, (uri) => uri.toString());
    hover.appendMarkdown(expandRefs(body, resolve));
    hover.appendMarkdown(
      `\n\n[$(book) Open](${commandUri('laxative.openNote', [note.id])})` +
        ` &nbsp;·&nbsp; [$(edit) Edit](${commandUri('laxative.editNote', [note.id])})` +
        ` &nbsp;·&nbsp; [$(trash) Delete](${commandUri('laxative.deleteNote', [note.id])})`
    );
  });
  return hover;
}
